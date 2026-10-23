require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Conexión a PostgreSQL en Neon Cloud
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Función auxiliar para contar padrón total, presentes y faltantes por turno
async function obtenerMetricas(colTurno) {
  const totalRes = await pool.query('SELECT COUNT(*) FROM participantes');
  const presRes = await pool.query('SELECT COUNT(*) FROM asistencias WHERE col_turno = $1', [colTurno]);
  const total = parseInt(totalRes.rows[0].count, 10) || 0;
  const presentes = parseInt(presRes.rows[0].count, 10) || 0;
  return { total, presentes, faltantes: Math.max(0, total - presentes) };
}

// Ruta de verificación
app.get('/', (req, res) => {
  res.send('API Control de Asistencia CS - Operativa');
});

// 1. ENDPOINT GET: Resumen por turno (/api/asistencia?col=10)
app.get('/api/asistencia', async (req, res) => {
  try {
    const col = parseInt(req.query.col, 10) || 10;
    const metricas = await obtenerMetricas(col);
    res.json({ estado: "RESUMEN", ...metricas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. ENDPOINT GET: Reporte detallado con filtros para la Web (/api/reporte?col=10&buscar=&estado=TODOS)
app.get('/api/reporte', async (req, res) => {
  try {
    const col = parseInt(req.query.col, 10) || 10;
    const busqueda = req.query.buscar || "";
    const filtroEstado = req.query.estado || "TODOS"; // TODOS, PRESENTE, FALTANTE

    let query = `
      SELECT 
        p.orden,
        p.sede_regional,
        p.sede_jurisdiccional,
        p.apellido_paterno,
        p.apellido_materno,
        p.nombres,
        p.dni,
        p.telefono,
        CASE WHEN a.id IS NOT NULL THEN 'PRESENTE' ELSE 'FALTANTE' END AS estado,
        TO_CHAR(a.fecha_hora, 'DD/MM/YYYY HH24:MI:SS') AS fecha_hora
      FROM participantes p
      LEFT JOIN asistencias a ON p.dni = a.dni AND a.col_turno = $1
      WHERE (p.dni ILIKE $2 OR p.nombres ILIKE $2 OR p.apellido_paterno ILIKE $2 OR p.apellido_materno ILIKE $2)
    `;

    const params = [col, `%${busqueda}%`];

    if (filtroEstado !== "TODOS") {
      if (filtroEstado === "PRESENTE") {
        query += ` AND a.id IS NOT NULL`;
      } else {
        query += ` AND a.id IS NULL`;
      }
    }

    query += ` ORDER BY p.orden::int ASC;`;

    const resultado = await pool.query(query, params);
    const metricas = await obtenerMetricas(col);

    res.json({
      ...metricas,
      asistentes: resultado.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. ENDPOINT POST: Registrar asistencia por DNI o QR (/api/asistencia)
app.post('/api/asistencia', async (req, res) => {
  try {
    let { dni, col, turno } = req.body;
    dni = String(dni || "").trim().padStart(8, '0');
    const colTurno = parseInt(col, 10) || 10;

    // 1. Buscar participante en el padrón
    const partRes = await pool.query('SELECT * FROM participantes WHERE dni = $1', [dni]);

    if (partRes.rows.length === 0) {
      const metricas = await obtenerMetricas(colTurno);
      return res.json({
        estado: "NO_REGISTRADO",
        titulo: "DNI NO SE ENCUENTRA EN EL PADRÓN",
        dni,
        turno,
        ...metricas
      });
    }

    const p = partRes.rows[0];
    const nombreCompleto = `${p.apellido_paterno} ${p.apellido_materno}, ${p.nombres}`.trim();

    // 2. Verificar si ya se registró en este turno
    const asisExistente = await pool.query(
      "SELECT TO_CHAR(fecha_hora, 'DD/MM/YYYY HH24:MI:SS') as fh FROM asistencias WHERE dni = $1 AND col_turno = $2",
      [dni, colTurno]
    );

    if (asisExistente.rows.length > 0) {
      const metricas = await obtenerMetricas(colTurno);
      return res.json({
        estado: "DUPLICADO",
        titulo: "DNI YA REGISTRADO EN ESTE TURNO",
        dni: p.dni,
        orden: p.orden || "",
        nombre: nombreCompleto,
        sedeRegional: p.sede_regional || "",
        sedeJurisdiccional: p.sede_jurisdiccional || "",
        seguro: p.seguro || "",
        telefono: p.telefono || "",
        turno,
        fechaHora: asisExistente.rows[0].fh,
        ...metricas
      });
    }

    // 3. Insertar nueva asistencia
    const insertRes = await pool.query(
      `INSERT INTO asistencias (dni, col_turno, etiqueta_turno) 
       VALUES ($1, $2, $3) 
       RETURNING TO_CHAR(fecha_hora, 'DD/MM/YYYY HH24:MI:SS') as fh`,
      [dni, colTurno, turno]
    );

    const metricas = await obtenerMetricas(colTurno);
    return res.json({
      estado: "REGISTRADO",
      titulo: "ASISTENCIA REGISTRADA CORRECTAMENTE",
      dni: p.dni,
      orden: p.orden || "",
      nombre: nombreCompleto,
      sedeRegional: p.sede_regional || "",
      sedeJurisdiccional: p.sede_jurisdiccional || "",
      seguro: p.seguro || "",
      telefono: p.telefono || "",
      turno,
      fechaHora: insertRes.rows[0].fh,
      ...metricas
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});