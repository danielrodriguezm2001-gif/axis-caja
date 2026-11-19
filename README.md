# Caja de Axis

Aplicación web independiente (sin servidor propio) para registrar los pagos de
productos, los gastos (con IVA) y ver el balance mensual y acumulado.

- Datos, login y tiempo real: Supabase (tablas `caja_*`, acceso por lista de emails en `caja_acceso`).
- El panel de salas lee los pagos de la Caja para ponerles su importe real a los pagos de AimHarder.
- Se publica con GitHub Pages desde `main`.
