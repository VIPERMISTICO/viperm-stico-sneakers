const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Configuración para recibir datos de formularios y JSON
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Conexión a la Base de Datos con variables de entorno (las configuraremos en Render)
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306
});

db.connect((err) => {
    if (err) {
        console.error('Error conectando a Clever Cloud:', err);
        return;
    }
    console.log('¡Conectado exitosamente a MySQL en Clever Cloud!');
});

// --- RUTA PRINCIPAL (PÁGINA VISUAL) ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- ENLACES INTERNOS (API) ---

// 1. Iniciar Sesión
app.post('/api/login', (req, res) => {
    const { nombre, password } = req.body;
    db.query('SELECT * FROM usuarios WHERE nombre = ? AND password = ?', [nombre, password], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length > 0) {
            res.json({ login: true, usuario: results[0] });
        } else {
            res.json({ login: false, mensaje: 'Usuario o contraseña incorrectos' });
        }
    });
});

// 2. Administrador: Crear Usuario
app.post('/api/usuarios', (req, res) => {
    const { nombre, password, rol } = req.body;
    db.query('INSERT INTO usuarios (nombre, password, rol) VALUES (?, ?, ?)', [nombre, password, rol], (err) => {
        if (err) return res.status(500).json({ error: 'El usuario ya existe o hay un error.' });
        res.json({ completado: true });
    });
});

// 3. Administrador: Dar de alta Pedido / Cajas / Tenis
app.post('/api/pedidos', (req, res) => {
    const { numero_pedido, fecha_pedido, modelo, cajas, piezas_caja } = req.body;
    const iniciales = parseInt(cajas) * parseInt(piezas_caja);
    
    db.query('INSERT INTO pedidos_inventario (numero_pedido, fecha_pedido, modelo, cajas_recibidas, piezas_por_caja, piezas_totales_iniciales, piezas_actuales_disponibles) VALUES (?, ?, ?, ?, ?, ?, ?)', 
    [numero_pedido, fecha_pedido, modelo, cajas, piezas_caja, iniciales, iniciales], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ completado: true });
    });
});

// 4. Ver Inventario General de Pedidos
app.get('/api/pedidos', (req, res) => {
    db.query('SELECT *, (piezas_totales_iniciales - piezas_actuales_disponibles) as vendidas_pedido FROM pedidos_inventario', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 5. Ver todos los usuarios (para transferencias)
app.get('/api/usuarios', (req, res) => {
    db.query('SELECT id, nombre, rol FROM usuarios', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 6. Administrador o Vendedor: Solicitar Transferencia (Mercancía o Dinero)
app.post('/api/transferencias', (req, res) => {
    const { remitente_id, destinatario_id, tipo, pedido_id, modelo, cantidad, monto } = req.body;
    db.query('INSERT INTO transferencias (remitente_id, destinatario_id, tipo_transferencia, pedido_id, modelo, cantidad_mercancia, monto_dinero) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [remitente_id, destinatario_id, tipo, pedido_id || null, modelo || null, cantidad || 0, monto || 0], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ completado: true });
    });
});

// 7. Ver Notificaciones / Transferencias pendientes del usuario logueado
app.get('/api/transferencias/:usuario_id', (req, res) => {
    const uId = req.params.usuario_id;
    db.query(`SELECT t.*, u.nombre as nombre_remitente 
              FROM transferencias t 
              JOIN usuarios u ON t.remitente_id = u.id 
              WHERE t.destinatario_id = ? AND t.estado = 'pendiente'`, [uId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 8. Autorizar o Rechazar Transferencia
app.post('/api/transferencias/procesar', (req, res) => {
    const { transferencia_id, accion } = req.body; // accion = 'autorizado' o 'rechazado'
    
    if (accion === 'rechazado') {
        db.query("UPDATE transferencias SET estado = 'rechazado' WHERE id = ?", [transferencia_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            return res.json({ completado: true });
        });
    } else {
        // Buscar los datos de la transferencia
        db.query('SELECT * FROM transferencias WHERE id = ?', [transferencia_id], (err, results) => {
            if (err || results.length === 0) return res.status(500).json({ error: 'No encontrada' });
            const t = results[0];
            
            if (t.tipo_transferencia === 'mercancia') {
                // Descontar del inventario general (o remitente si fuera venta, pero asumimos reparto del admin inicialmente)
                db.query('UPDATE pedidos_inventario SET piezas_actuales_disponibles = piezas_actuales_disponibles - ? WHERE id = ?', [t.cantidad_mercancia, t.pedido_id], (err2) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    
                    // Añadir o actualizar stock en el inventario del usuario destinatario
                    db.query('INSERT INTO inventario_usuarios (usuario_id, pedido_id, modelo, piezas_vendedor) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE piezas_vendedor = piezas_vendedor + ?',
                    [t.destinatario_id, t.pedido_id, t.modelo, t.cantidad_mercancia, t.cantidad_mercancia], (err3) => {
                        if (err3) return res.status(500).json({ error: err3.message });
                        
                        db.query("UPDATE transferencias SET estado = 'autorizado' WHERE id = ?", [transferencia_id], () => {
                            res.json({ completado: true });
                        });
                    });
                });
            } else {
                // Dinero: Simplemente autorizar el registro para historial de movimientos
                db.query("UPDATE transferencias SET estado = 'autorizado' WHERE id = ?", [transferencia_id], () => {
                    res.json({ completado: true });
                });
            }
        });
    }
});

// 9. Ver Inventario Personal de un Vendedor
app.get('/api/inventario-vendedor/:usuario_id', (req, res) => {
    db.query(`SELECT iv.*, p.numero_pedido 
              FROM inventario_usuarios iv 
              JOIN pedidos_inventario p ON iv.pedido_id = p.id 
              WHERE iv.usuario_id = ?`, [req.params.usuario_id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 10. Registrar una Venta (Consumo de piezas)
app.post('/api/ventas', (req, res) => {
    const { usuario_id, pedido_id, modelo, cantidad, precio } = req.body;
    const total = parseFloat(cantidad) * parseFloat(precio);
    
    // Verificar si tiene stock suficiente
    db.query('SELECT piezas_vendedor FROM inventario_usuarios WHERE usuario_id = ? AND pedido_id = ?', [usuario_id, pedido_id], (err, results) => {
        if (err || results.length === 0 || results[0].piezas_vendedor < cantidad) {
            return res.status(400).json({ error: 'No tienes suficientes tenis en tu inventario personal.' });
        }
        
        // Descontar del vendedor
        db.query('UPDATE inventario_usuarios SET piezas_vendedor = piezas_vendedor - ? WHERE usuario_id = ? AND pedido_id = ?', [cantidad, usuario_id, pedido_id], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            
            // Insertar en la tabla de ventas
            db.query('INSERT INTO ventas (usuario_id, pedido_id, modelo, cantidad_vendida, precio_unitario, monto_total) VALUES (?, ?, ?, ?, ?, ?)',
            [usuario_id, pedido_id, modelo, cantidad, precio, total], (err3) => {
                if (err3) return res.status(500).json({ error: err3.message });
                res.json({ completado: true });
            });
        });
    });
});

// 11. Reporte Global y Personal de Dinero Vendido
app.get('/api/reporte-ventas/:usuario_id', (req, res) => {
    const uId = req.params.usuario_id;
    // Total de todos los usuarios juntos
    db.query('SELECT SUM(monto_total) as total_global FROM ventas', (err, resGlobal) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // Total de este usuario específico
        db.query('SELECT SUM(monto_total) as total_personal FROM ventas WHERE usuario_id = ?', [uId], (err2, resPersonal) => {
            if (err2) return res.status(500).json({ error: err2.message });
            
            res.json({
                global: resGlobal[0].total_global || 0,
                personal: resPersonal[0].total_personal || 0
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
