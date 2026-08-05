const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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
    console.log('¡Conectado exitosamente a MySQL mejorado!');
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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

// 2. Administrador: Crear Vendedor
app.post('/api/usuarios', (req, res) => {
    const { nombre, password, rol } = req.body;
    db.query('INSERT INTO usuarios (nombre, password, rol) VALUES (?, ?, ?)', [nombre, password, rol], (err) => {
        if (err) return res.status(500).json({ error: 'El usuario ya existe.' });
        res.json({ completado: true });
    });
});

// 3. Administrador: Registrar o Buscar Encabezado de Pedido
app.post('/api/pedidos/encabezado', (req, res) => {
    const { numero_pedido, fecha_pedido } = req.body;
    db.query('INSERT INTO pedidos_encabezado (numero_pedido, fecha_pedido) VALUES (?, ?) ON DUPLICATE KEY UPDATE fecha_pedido=VALUES(fecha_pedido)', 
    [numero_pedido, fecha_pedido], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.query('SELECT id FROM pedidos_encabezado WHERE numero_pedido = ?', [numero_pedido], (err2, results) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ completado: true, pedido_id: results[0].id });
        });
    });
});

// 4. Administrador: Agregar renglón de detalle (Modelo) a un Pedido
app.post('/api/pedidos/detalle', (req, res) => {
    const { pedido_id, modelo, cajas, piezas_caja } = req.body;
    const iniciales = parseInt(cajas) * parseInt(piezas_caja);
    
    db.query('INSERT INTO pedidos_detalle (pedido_id, modelo, cajas_recibidas, piezas_por_caja, piezas_totales_iniciales, piezas_actuales_disponibles) VALUES (?, ?, ?, ?, ?, ?)', 
    [pedido_id, modelo, cajas, piezas_caja, iniciales, iniciales], (err) => {
        if (err) return res.status(500).json({ error: 'Este modelo ya está registrado en este pedido.' });
        res.json({ completado: true });
    });
});

// 5. Ver Inventario General Completo (Agrupado por Pedido)
app.get('/api/pedidos/general', (req, res) => {
    const query = `
        SELECT pe.numero_pedido, pe.fecha_pedido, pd.id as detalle_id, pd.modelo, pd.cajas_recibidas, pd.piezas_por_caja, pd.piezas_totales_iniciales, pd.piezas_actuales_disponibles,
        (pd.piezas_totales_iniciales - pd.piezas_actuales_disponibles) as vendidas_pedido
        FROM pedidos_detalle pd
        JOIN pedidos_encabezado pe ON pd.pedido_id = pe.id
        ORDER BY pe.fecha_pedido DESC, pe.numero_pedido ASC`;
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 6. Ver todos los usuarios
app.get('/api/usuarios', (req, res) => {
    db.query('SELECT id, nombre, rol FROM usuarios', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 7. Solicitar Transferencia de Mercancía
app.post('/api/transferencias', (req, res) => {
    const { remitente_id, destinatario_id, tipo, detalle_id, cantidad, monto } = req.body;
    db.query('INSERT INTO transferencias (remitente_id, destinatario_id, tipo_transferencia, detalle_id, cantidad_mercancia, monto_dinero) VALUES (?, ?, ?, ?, ?, ?)',
    [remitente_id, destinatario_id, tipo, detalle_id || null, cantidad || 0, monto || 0], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ completado: true });
    });
});

// 8. Ver Notificaciones de un Usuario
app.get('/api/transferencias/:usuario_id', (req, res) => {
    const query = `
        SELECT t.*, u.nombre as nombre_remitente, pd.modelo 
        FROM transferencias t 
        JOIN usuarios u ON t.remitente_id = u.id 
        LEFT JOIN pedidos_detalle pd ON t.detalle_id = pd.id
        WHERE t.destinatario_id = ? AND t.estado = 'pendiente'`;
    db.query(query, [req.params.usuario_id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 9. Procesar Autorización de Transferencia
app.post('/api/transferencias/procesar', (req, res) => {
    const { transferencia_id, accion } = req.body;
    if (accion === 'rechazado') {
        db.query("UPDATE transferencias SET estado = 'rechazado' WHERE id = ?", [transferencia_id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            return res.json({ completado: true });
        });
    } else {
        db.query('SELECT * FROM transferencias WHERE id = ?', [transferencia_id], (err, results) => {
            if (err || results.length === 0) return res.status(500).json({ error: 'No encontrada' });
            const t = results[0];
            
            if (t.tipo_transferencia === 'mercancia') {
                db.query('UPDATE pedidos_detalle SET piezas_actuales_disponibles = piezas_actuales_disponibles - ? WHERE id = ?', [t.cantidad_mercancia, t.detalle_id], (err2) => {
                    if (err2) return res.status(500).json({ error: err2.message });
                    
                    db.query('INSERT INTO inventario_usuarios (usuario_id, detalle_id, piezas_vendedor) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE piezas_vendedor = piezas_vendedor + ?',
                    [t.destinatario_id, t.detalle_id, t.cantidad_mercancia, t.cantidad_mercancia], (err3) => {
                        if (err3) return res.status(500).json({ error: err3.message });
                        
                        db.query("UPDATE transferencias SET estado = 'autorizado' WHERE id = ?", [transferencia_id], () => {
                            res.json({ completado: true });
                        });
                    });
                });
            } else {
                db.query("UPDATE transferencias SET estado = 'autorizado' WHERE id = ?", [transferencia_id], () => {
                    res.json({ completado: true });
                });
            }
        });
    }
});

// 10. Ver Inventario de un Vendedor
app.get('/api/inventario-vendedor/:usuario_id', (req, res) => {
    const query = `
        SELECT iv.*, pd.modelo, pe.numero_pedido 
        FROM inventario_usuarios iv 
        JOIN pedidos_detalle pd ON iv.detalle_id = pd.id 
        JOIN pedidos_encabezado pe ON pd.pedido_id = pe.id
        WHERE iv.usuario_id = ?`;
    db.query(query, [req.params.usuario_id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 11. Registrar una Venta (Consumo)
app.post('/api/ventas', (req, res) => {
    const { usuario_id, detalle_id, cantidad, precio } = req.body;
    const total = parseFloat(cantidad) * parseFloat(precio);
    
    db.query('SELECT piezas_vendedor FROM inventario_usuarios WHERE usuario_id = ? AND detalle_id = ?', [usuario_id, detalle_id], (err, results) => {
        if (err || results.length === 0 || results[0].piezas_vendedor < cantidad) {
            return res.status(400).json({ error: 'Stock insuficiente en tu inventario personal.' });
        }
        
        db.query('UPDATE inventario_usuarios SET piezas_vendedor = piezas_vendedor - ? WHERE usuario_id = ? AND detalle_id = ?', [amount = cantidad, usuario_id, detalle_id], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            
            db.query('INSERT INTO ventas (usuario_id, detalle_id, cantidad_vendida, precio_unitario, monto_total) VALUES (?, ?, ?, ?, ?)',
            [usuario_id, detalle_id, cantidad, precio, total], (err3) => {
                if (err3) return res.status(500).json({ error: err3.message });
                res.json({ completado: true });
            });
        });
    });
});

// 12. Reportes Financieros
app.get('/api/reporte-ventas/:usuario_id', (req, res) => {
    db.query('SELECT SUM(monto_total) as total_global FROM ventas', (err, resGlobal) => {
        if (err) return res.status(500).json({ error: err.message });
        db.query('SELECT SUM(monto_total) as total_personal FROM ventas WHERE usuario_id = ?', [req.params.usuario_id], (err2, resPersonal) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({
                global: resGlobal[0].total_global || 0,
                personal: resPersonal[0].total_personal || 0
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
