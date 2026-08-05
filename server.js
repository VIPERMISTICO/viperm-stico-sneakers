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
    console.log('¡Conectado exitosamente al sistema de reservas y catálogo!');
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
            res.json({ login: true, usuario: results[0] }); // Envía el primer renglón directo
        } else {
            res.json({ login: false, mensaje: 'Usuario o contraseña incorrectos' });
        }
    });
});

// 2. Catálogo: Registrar nuevo modelo de tenis único
app.post('/api/modelos', (req, res) => {
    const { nombre_modelo } = req.body;
    db.query('INSERT INTO modelos (nombre_modelo) VALUES (?)', [nombre_modelo], (err) => {
        if (err) return res.status(500).json({ error: 'El modelo ya existe en el catálogo.' });
        res.json({ completado: true });
    });
});

// 3. Catálogo: Obtener todos los modelos registrados
app.get('/api/modelos', (req, res) => {
    db.query('SELECT * FROM modelos ORDER BY nombre_modelo ASC', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 4. Administrador: Crear Vendedor
app.post('/api/usuarios', (req, res) => {
    const { nombre, password, rol } = req.body;
    db.query('INSERT INTO usuarios (nombre, password, rol) VALUES (?, ?, ?)', [nombre, password, rol], (err) => {
        if (err) return res.status(500).json({ error: 'El usuario ya existe.' });
        res.json({ completado: true });
    });
});

// 5. Administrador: Registrar o Buscar Encabezado de Pedido
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

// 6. Administrador: Agregar renglón de detalle (Modelo) a un Pedido
app.post('/api/pedidos/detalle', (req, res) => {
    const { pedido_id, modelo_id, cajas, piezas_caja } = req.body;
    const iniciales = parseInt(cajas) * parseInt(piezas_caja);
    
    db.query('INSERT INTO pedidos_detalle (pedido_id, modelo_id, cajas_recibidas, piezas_por_caja, piezas_totales_iniciales, piezas_actuales_disponibles) VALUES (?, ?, ?, ?, ?, ?)', 
    [pedido_id, modelo_id, cajas, piezas_caja, iniciales, iniciales], (err) => {
        if (err) return res.status(500).json({ error: 'Este modelo ya está registrado en este pedido.' });
        res.json({ completado: true });
    });
});


// 7. Ver Inventario General Completo
app.get('/api/pedidos/general', (req, res) => {
    const query = `
        SELECT pe.numero_pedido, pe.fecha_pedido, pd.id as detalle_id, m.nombre_modelo as modelo, pd.cajas_recibidas, pd.piezas_por_caja, pd.piezas_totales_iniciales, pd.piezas_actuales_disponibles,
        (pd.piezas_totales_iniciales - pd.piezas_actuales_disponibles) as vendidas_pedido
        FROM pedidos_detalle pd
        JOIN pedidos_encabezado pe ON pd.pedido_id = pe.id
        JOIN modelos m ON pd.modelo_id = m.id
        ORDER BY pe.fecha_pedido DESC, pe.numero_pedido ASC`;
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 8. Ver todos los usuarios
app.get('/api/usuarios', (req, res) => {
    db.query('SELECT id, nombre, rol FROM usuarios', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 9. Enviar Transferencia con REGLA DE RESERVA INMEDIATA
app.post('/api/transferencias', (req, res) => {
    const { remitente_id, destinatario_id, tipo, detalle_id, cantidad } = req.body;
    
    db.query('SELECT piezas_actuales_disponibles FROM pedidos_detalle WHERE id = ?', [detalle_id], (err, results) => {
        if (err || results.length === 0) return res.status(500).json({ error: 'Lote no encontrado' });
        
        if (results[0].piezas_actuales_disponibles < cantidad) {
            return res.status(400).json({ error: 'No puedes enviar esa cantidad. Supera las piezas disponibles actuales.' });
        }
        
        db.query('UPDATE pedidos_detalle SET piezas_actuales_disponibles = piezas_actuales_disponibles - ? WHERE id = ?', [cantidad, detalle_id], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            
            db.query('INSERT INTO transferencias (remitente_id, destinatario_id, tipo_transferencia, detalle_id, cantidad_mercancia) VALUES (?, ?, ?, ?, ?)',
            [remitente_id, destinatario_id, tipo, detalle_id, cantidad], (err3) => {
                if (err3) return res.status(500).json({ error: err3.message });
                res.json({ completado: true });
            });
        });
    });
});

// 10. Ver Notificaciones de un Usuario
app.get('/api/transferencias/:usuario_id', (req, res) => {
    const query = `
        SELECT t.*, u.nombre as nombre_remitente, m.nombre_modelo as modelo 
        FROM transferencias t 
        JOIN usuarios u ON t.remitente_id = u.id 
        LEFT JOIN pedidos_detalle pd ON t.detalle_id = pd.id
        LEFT JOIN modelos m ON pd.modelo_id = m.id
        WHERE t.destinatario_id = ? AND t.estado = 'pendiente'`;
    db.query(query, [req.params.usuario_id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 11. Procesar Autorización (Acepta o Devuelve la reserva si se rechaza)
app.post('/api/transferencias/procesar', (req, res) => {
    const { transferencia_id, accion } = req.body;
    
    db.query('SELECT * FROM transferencias WHERE id = ?', [transferencia_id], (err, results) => {
        if (err || results.length === 0) return res.status(500).json({ error: 'Transferencia no encontrada' });
        const t = results[0];
        
        if (accion === 'rechazado') {
            db.query('UPDATE pedidos_detalle SET piezas_actuales_disponibles = piezas_actuales_disponibles + ? WHERE id = ?', [t.cantidad_mercancia, t.detalle_id], (err2) => {
                if (err2) return res.status(500).json({ error: err2.message });
                
                db.query("UPDATE transferencias SET estado = 'rechazado' WHERE id = ?", [transferencia_id], () => {
                    res.json({ completado: true, mensaje: 'Reserva devuelta al almacén' });
                });
            });
        } else {
            db.query('INSERT INTO inventario_usuarios (usuario_id, detalle_id, piezas_vendedor) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE piezas_vendedor = piezas_vendedor + ?',
            [t.destinatario_id, t.detalle_id, t.cantidad_mercancia, t.cantidad_mercancia], (err3) => {
                if (err3) return res.status(500).json({ error: err3.message });
                
                db.query("UPDATE transferencias SET estado = 'autorizado' WHERE id = ?", [transferencia_id], () => {
                    res.json({ completado: true });
                });
            });
        }
    });
});

// 12. Ver Inventario de un Vendedor
app.get('/api/inventario-vendedor/:usuario_id', (req, res) => {
    const query = `
        SELECT iv.*, m.nombre_modelo as modelo, pe.numero_pedido 
        FROM inventario_usuarios iv 
        JOIN pedidos_detalle pd ON iv.detalle_id = pd.id 
        JOIN pedidos_encabezado pe ON pd.pedido_id = pe.id
        JOIN modelos m ON pd.modelo_id = m.id
        WHERE iv.usuario_id = ?`;
    db.query(query, [req.params.usuario_id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 13. Registrar una Venta
app.post('/api/ventas', (req, res) => {
    const { usuario_id, detalle_id, cantidad, precio } = req.body;
    const total = parseFloat(cantidad) * parseFloat(precio);
    
    db.query('SELECT piezas_vendedor FROM inventario_usuarios WHERE usuario_id = ? AND detalle_id = ?', [usuario_id, detalle_id], (err, results) => {
        if (err || results.length === 0 || results[0].piezas_vendedor < cantidad) {
            return res.status(400).json({ error: 'Stock insuficiente en tu inventario personal.' });
        }
        
        db.query('UPDATE inventario_usuarios SET piezas_vendedor = piezas_vendedor - ? WHERE usuario_id = ? AND detalle_id = ?', [cantidad, usuario_id, detalle_id], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            
            db.query('INSERT INTO ventas (usuario_id, detalle_id, cantidad_vendida, precio_unitario, monto_total) VALUES (?, ?, ?, ?, ?)',
            [usuario_id, detalle_id, cantidad, precio, total], (err3) => {
                if (err3) return res.status(500).json({ error: err3.message });
                res.json({ completado: true });
            });
        });
    });
});

// 14. Reportes Financieros
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
    console.log(`Servidor de reservas corriendo en puerto ${PORT}`);
});