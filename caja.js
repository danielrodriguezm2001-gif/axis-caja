/* Caja de Axis: pagos de productos, gastos y balance (Supabase, tiempo real,
 * varios usuarios y dispositivos). Aplicación independiente del panel de salas.
 *
 * Los pagos que se registran aquí los lee el panel de salas para poner el importe
 * real a los pagos de AimHarder (que van a 0 €); el emparejado se hace allí.
 */
(function () {
  const SB_URL = "https://jakvmfippiakvfgvzeam.supabase.co";
  const SB_KEY = "sb_publishable_OYbWV66QORfVoj0Gj0NqIw_mkPSgiYQ"; // clave pública: los permisos los da RLS
  const CACHE_KEY = "axis-caja-app-cache";
  const VENDEDORES = ["Marc", "Erik", "Daniel", "Sergio", "Martí", "Marina", "Axis"];
  const INK = "#12211B", MUTED = "#5A6B63", LINE = "#DDE4E0", SOFT = "#EDF1EF", BAD = "#9B1C1C", WARN = "#B45309", GOOD = "#1F3A2A";
  const h = React.createElement;
  const { useState, useEffect, useMemo, useRef, useCallback } = React;

  let sb = null;
  try {
    sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  } catch (e) {
    console.warn("Caja: no se pudo cargar Supabase", e);
  }

  const eur2 = (n) => (Number(n) || 0).toLocaleString("es-ES", { style: "currency", currency: "EUR" });
  const pad = (n) => String(n).padStart(2, "0");
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const shiftMonth = (ym, delta) => {
    const [y, m] = ym.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 15);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  };
  const stripAccents = (s) => (s || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  // Misma normalización que el panel de salas (nombre_norm de los clientes).
  const normName = (s) => stripAccents(s).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  function catFromConcept(concept) {
    const t = stripAccents(concept);
    if (t.includes("bono 4")) return "Pack 4";
    if (t.includes("bono 8")) return "Pack 8";
    if (t.includes("grupo")) return "Small group / Grupo reducido";
    if (t.includes("valoraci")) return "Valoración inicial";
    if (t.includes("online")) return "Online";
    if (t.includes("individual")) return "Sesión individual";
    return String(concept || "").replace(/\s*\d{1,2}\/\d{4}\s*$/, "").trim() || "Sin concepto";
  }

  const CONFIG_VACIA = { saldo_inicial_efectivo_cents: 0, saldo_inicial_fecha: null };
  const CATEGORIAS_GASTO = ["Alquiler", "Suministros (luz, agua, internet)", "Material y equipamiento", "Mantenimiento y limpieza", "Colaboradores y nóminas", "Seguros", "Gestoría y asesoría", "Software y suscripciones", "Marketing y publicidad", "Formación", "Impuestos y tasas", "Comisiones bancarias", "Otros"];
  const TIPOS_IVA = [21, 10, 4, 0];
  // Fisioterapia, nutrición y psicología van sin IVA (exentos); el resto al 21 %.
  const ivaPorDefecto = (nombre) => (/fisio|nutri|psico/.test(normName(nombre)) ? 0 : 21);
  const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

  // Reparto base / IVA / total en céntimos, sin que se pierda ninguno (total = base + IVA).
  function calcIva(importe, tasa, incluyeIva) {
    if (incluyeIva) {
      const total = Math.round(importe * 100), base = Math.round(total / (1 + tasa / 100));
      return { base, iva: total - base, total };
    }
    const base = Math.round(importe * 100), iva = Math.round(base * tasa / 100);
    return { base, iva, total: base + iva };
  }

  /* ---------- conexión: sesión, datos y tiempo real ---------- */
  function useCaja() {
    const [estado, setEstado] = useState(sb ? "cargando" : "error"); // cargando | sin-sesion | sin-acceso | ok | error
    const [error, setError] = useState(sb ? "" : "No se pudo cargar la librería de Supabase.");
    const [sesion, setSesion] = useState(null);
    const [rol, setRol] = useState(null);
    const cache = useRef(null);
    if (cache.current === null) { try { cache.current = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch (e) { cache.current = {}; } }
    const [pagos, setPagos] = useState(() => cache.current.pagos || []);
    const [gastos, setGastos] = useState(() => cache.current.gastos || []);
    const [conceptos, setConceptos] = useState(() => cache.current.conceptos || []);
    const conceptosRef = useRef([]);
    conceptosRef.current = conceptos;
    const [config, setConfig] = useState(() => cache.current.config || CONFIG_VACIA);
    const [clientes, setClientes] = useState([]);
    const [enVivo, setEnVivo] = useState(false);
    const [desactualizado, setDesactualizado] = useState(true); // true hasta leer de Supabase
    const clientesRef = useRef([]);
    clientesRef.current = clientes;

    const cargar = useCallback(async () => {
      if (!sb) return;
      try {
        const leer = async (tabla, orden) => {
          const filas = [];
          for (let desde = 0; ; desde += 1000) {
            const { data, error: e } = await sb.from(tabla).select("*").order(orden.col, { ascending: orden.asc }).range(desde, desde + 999);
            if (e) throw e;
            filas.push(...data);
            if (data.length < 1000) break;
          }
          return filas;
        };
        const [p, c, g, cfg, cs] = await Promise.all([leer("caja_pagos", { col: "fecha", asc: false }), leer("caja_clientes", { col: "nombre", asc: true }), leer("caja_gastos", { col: "fecha", asc: false }), sb.from("caja_config").select("*").eq("id", 1).maybeSingle(), leer("caja_conceptos", { col: "nombre", asc: true })]);
        if (cfg.error) throw cfg.error;
        setPagos(p);
        setClientes(c);
        setGastos(g);
        setConceptos(cs);
        setConfig(cfg.data || CONFIG_VACIA);
        setDesactualizado(false);
        setError("");
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ pagos: p, gastos: g, config: cfg.data || CONFIG_VACIA, conceptos: cs })); } catch (e) { /* sin caché */ }
      } catch (e) {
        setDesactualizado(true);
        setError("No se han podido leer los pagos de la Caja (" + (e.message || e) + "). Se muestran los últimos guardados.");
      }
    }, []);

    // Sesión de Supabase Auth
    useEffect(() => {
      if (!sb) return;
      let vivo = true;
      sb.auth.getSession().then(({ data }) => { if (vivo) { setSesion(data.session); if (!data.session) setEstado("sin-sesion"); } });
      const { data: sub } = sb.auth.onAuthStateChange((_ev, s) => { setSesion(s); if (!s) { setRol(null); setEstado("sin-sesion"); } });
      return () => { vivo = false; sub.subscription.unsubscribe(); };
    }, []);

    // Con sesión: rol, datos y suscripción en tiempo real
    const uid = sesion && sesion.user && sesion.user.id;
    useEffect(() => {
      if (!sb || !uid) return;
      let vivo = true, canal = null, temporizador = null;
      (async () => {
        const { data, error: e } = await sb.rpc("caja_rol");
        if (!vivo) return;
        if (e) { setEstado("error"); setError("No se pudo comprobar el acceso (" + e.message + ")."); return; }
        if (!data) { setRol(null); setEstado("sin-acceso"); return; }
        setRol(data);
        setEstado("ok");
        await cargar();
        if (!vivo) return;
        const refrescar = () => { clearTimeout(temporizador); temporizador = setTimeout(cargar, 250); };
        canal = sb.channel("caja-axis")
          .on("postgres_changes", { event: "*", schema: "public", table: "caja_pagos" }, refrescar)
          .on("postgres_changes", { event: "*", schema: "public", table: "caja_clientes" }, refrescar)
          .on("postgres_changes", { event: "*", schema: "public", table: "caja_gastos" }, refrescar)
          .on("postgres_changes", { event: "*", schema: "public", table: "caja_config" }, refrescar)
          .on("postgres_changes", { event: "*", schema: "public", table: "caja_conceptos" }, refrescar)
          .subscribe((s) => { setEnVivo(s === "SUBSCRIBED"); if (s === "SUBSCRIBED") cargar(); });
      })();
      return () => { vivo = false; clearTimeout(temporizador); if (canal) sb.removeChannel(canal); setEnVivo(false); };
    }, [uid, cargar]);

    const puedeEditar = rol === "admin" || rol === "editor";
    const api = {
      async entrar(email, clave) {
        const { error: e } = await sb.auth.signInWithPassword({ email: email.trim(), password: clave });
        if (e) throw new Error(e.message === "Invalid login credentials" ? "Email o contraseña incorrectos." : e.message);
      },
      async salir() { await sb.auth.signOut(); },
      async guardarPago(d, id) {
        if (!puedeEditar) throw new Error("Tu usuario solo puede ver la Caja.");
        const nombre = d.cliente_nombre.trim();
        let cliente = nombre ? clientesRef.current.find((c) => c.nombre_norm === normName(nombre)) : null;
        if (nombre && !cliente) {
          const { data, error: e } = await sb.from("caja_clientes").upsert({ nombre, nombre_norm: normName(nombre), origen: "manual" }, { onConflict: "nombre_norm" }).select().single();
          if (e) throw e;
          cliente = data;
        }
        if (!cliente) throw new Error("Elige un cliente.");
        const nombreConcepto = d.concepto.trim();
        if (!conceptosRef.current.some((k) => k.nombre_norm === normName(nombreConcepto))) {
          // Concepto nuevo: queda guardado (como manual) con este IVA y este importe como habituales.
          const { error: e } = await sb.from("caja_conceptos").upsert({ nombre: nombreConcepto, nombre_norm: normName(nombreConcepto), precio_cents: Math.round(d.importe * 100), iva_rate: d.iva_rate, origen: "manual" }, { onConflict: "nombre_norm", ignoreDuplicates: true });
          if (e) throw e;
        }
        const c = calcIva(d.importe, d.iva_rate, d.incluye_iva);
        // Caja de efectivo: solo cobros, siempre en efectivo.
        const fila = { cliente_id: cliente.id, cliente_nombre: cliente.nombre, concepto: d.concepto.trim(), importe_cents: c.total, base_cents: c.base, iva_rate: d.iva_rate, iva_cents: c.iva, fecha: d.fecha, forma_pago: "efectivo", estado: "cobrado", vendedor: d.vendedor, sin_aimharder: !!d.sin_aimharder, notas: d.notas.trim(), updated_at: new Date().toISOString() };
        const r = id ? await sb.from("caja_pagos").update(fila).eq("id", id) : await sb.from("caja_pagos").insert({ ...fila, creado_por: sesion.user.email });
        if (r.error) throw r.error;
        await cargar();
      },
      // d: { fecha, concepto, proveedor, categoria, importe, iva_rate, incluye_iva, factura, notas }
      async guardarGasto(d, id) {
        if (!puedeEditar) throw new Error("Tu usuario solo puede ver la Caja.");
        const c = calcIva(d.importe, d.iva_rate, d.incluye_iva);
        const fila = { fecha: d.fecha, concepto: d.concepto.trim(), proveedor: d.proveedor.trim(), categoria: d.categoria, base_cents: c.base, iva_rate: d.iva_rate, iva_cents: c.iva, total_cents: c.total, forma_pago: "efectivo", estado: "pagado", factura: d.factura.trim(), notas: d.notas.trim(), updated_at: new Date().toISOString() };
        const r = id ? await sb.from("caja_gastos").update(fila).eq("id", id) : await sb.from("caja_gastos").insert({ ...fila, creado_por: sesion.user.email });
        if (r.error) throw r.error;
        await cargar();
      },
      async borrarGasto(id) {
        const { error: e } = await sb.from("caja_gastos").delete().eq("id", id);
        if (e) throw e;
        await cargar();
      },
      // Solo admin: con cuánto efectivo se empieza a contar el acumulado.
      async guardarConfig(c) {
        const { error: e } = await sb.from("caja_config").update({ saldo_inicial_efectivo_cents: c.efectivo, saldo_inicial_fecha: c.fecha || null, updated_at: new Date().toISOString() }).eq("id", 1);
        if (e) throw e;
        await cargar();
      },
      async actualizarConcepto(id, cambios) {
        if (!puedeEditar) throw new Error("Tu usuario solo puede ver la Caja.");
        const { error: e } = await sb.from("caja_conceptos").update(cambios).eq("id", id);
        if (e) throw e;
        await cargar();
      },
      async borrarConcepto(id) {
        const { error: e } = await sb.from("caja_conceptos").delete().eq("id", id);
        if (e) throw e;
        await cargar();
      },
      async borrarPago(id) {
        const { error: e } = await sb.from("caja_pagos").delete().eq("id", id);
        if (e) throw e;
        await cargar();
      },
    };
    return { estado, error, sesion, rol, puedeEditar, esAdmin: rol === "admin", pagos, clientes, gastos, config, conceptos, enVivo, desactualizado, api };
  }

  /* ---------- pantalla ---------- */
  const box = { background: "#fff", border: `1px solid ${LINE}`, borderRadius: 12, padding: 16 };
  const lbl = { fontSize: 12, color: MUTED, display: "grid", gap: 3 };
  const eurC = (cents) => eur2((cents || 0) / 100);
  const BAR_IN = "#2F7D4F", BAR_OUT = "#B23A3A";
  const vacio = () => ({ fecha: todayISO(), cliente_nombre: "", concepto: "", importe: "", iva_rate: 21, incluye_iva: true, vendedor: "", sin_aimharder: false, notas: "" });
  const vacioGasto = () => ({ fecha: todayISO(), concepto: "", proveedor: "", categoria: CATEGORIAS_GASTO[0], importe: "", iva_rate: 21, incluye_iva: true, factura: "", notas: "" });
  const campoIva = (f, set) => [
    h("label", { key: "inc", style: lbl }, "El importe…", h("select", { className: "axis-input", value: f.incluye_iva ? "si" : "no", onChange: set("incluye_iva") }, h("option", { value: "si" }, "ya incluye el IVA (total)"), h("option", { value: "no" }, "es sin IVA (se suma)"))),
    h("label", { key: "iva", style: lbl }, "IVA (%)", h("select", { className: "axis-input", value: f.iva_rate, onChange: set("iva_rate") }, TIPOS_IVA.map((t) => h("option", { key: t, value: t }, t === 0 ? "0 % (exento)" : `${t} %`))))];
  const setter = (f, setF) => (k) => (e) => setF({ ...f, [k]: k === "iva_rate" ? Number(e.target.value) : k === "incluye_iva" ? e.target.value === "si" : e.target.type === "checkbox" ? e.target.checked : e.target.value });

  function Login({ caja }) {
    const [email, setEmail] = useState("");
    const [clave, setClave] = useState("");
    const [msg, setMsg] = useState("");
    const [busy, setBusy] = useState(false);
    const enviar = async (ev) => {
      ev.preventDefault();
      setBusy(true); setMsg("");
      try { await caja.api.entrar(email, clave); } catch (e) { setMsg(e.message); } finally { setBusy(false); }
    };
    return h("form", { onSubmit: enviar, style: { display: "grid", gap: 10, maxWidth: 360 } },
      h("label", { style: lbl }, "Email", h("input", { className: "axis-input", type: "email", autoComplete: "username", value: email, onChange: (e) => setEmail(e.target.value), required: true })),
      h("label", { style: lbl }, "Contraseña", h("input", { className: "axis-input", type: "password", autoComplete: "current-password", value: clave, onChange: (e) => setClave(e.target.value), required: true })),
      h("div", null, h("button", { className: "axis-btn primary", type: "submit", disabled: busy }, busy ? "Entrando…" : "Entrar")),
      msg && h("p", { style: { margin: 0, fontSize: 13, color: BAD } }, msg));
  }

  // Desplegable de clientes con buscador: se escribe parte del nombre (en cualquier
  // orden) y se elige de la lista. Si no existe, ofrece crearlo.
  function SelectorLista({ items, value, onChange, placeholder, nuevo, vacio }) {
    const [abierto, setAbierto] = useState(false);
    const [texto, setTexto] = useState("");
    const [activo, setActivo] = useState(0);
    const id = useRef("sel-" + Math.random().toString(36).slice(2, 8)).current;
    const q = normName(texto);
    const coincidencias = useMemo(() => {
      const t = q.split(" ").filter(Boolean);
      return items.filter((c) => t.every((x) => c.nombre_norm.includes(x)));
    }, [items, q]);
    const visibles = coincidencias.slice(0, 60);
    const crear = texto.trim() && !items.some((c) => c.nombre_norm === q) ? texto.trim() : null;
    const opciones = [...visibles.map((c) => ({ nombre: c.nombre, nuevo: false, item: c })), ...(crear ? [{ nombre: crear, nuevo: true, item: null }] : [])];
    const elegir = (o) => { onChange(o.nombre, o.item); setTexto(""); setAbierto(false); };
    const teclas = (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setAbierto(true); setActivo((a) => Math.min(a + 1, opciones.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActivo((a) => Math.max(a - 1, 0)); }
      else if (e.key === "Enter" && abierto && opciones[activo]) { e.preventDefault(); elegir(opciones[activo]); }
      else if (e.key === "Escape" || e.key === "Tab") setAbierto(false);
    };
    return h("div", { style: { position: "relative" } },
      h("input", { className: "axis-input", role: "combobox", "aria-expanded": abierto, "aria-controls": id, "aria-autocomplete": "list", autoComplete: "off", placeholder,
        value: abierto ? texto : value, style: value && !abierto ? { fontWeight: 600, paddingRight: 28 } : undefined,
        onFocus: () => { setTexto(""); setActivo(0); setAbierto(true); },
        onBlur: () => setAbierto(false),
        onChange: (e) => { setTexto(e.target.value); setActivo(0); setAbierto(true); },
        onKeyDown: teclas }),
      value && !abierto && h("button", { type: "button", "aria-label": "Quitar selección", onMouseDown: (e) => { e.preventDefault(); onChange("", null); }, style: { position: "absolute", right: 4, top: 3, border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: MUTED } }, "×"),
      abierto && h("div", { id, role: "listbox", style: { position: "absolute", left: 0, right: 0, top: "100%", marginTop: 2, maxHeight: 240, overflowY: "auto", background: "#fff", border: `1px solid #C9D2CD`, borderRadius: 6, boxShadow: "0 6px 18px rgba(0,0,0,.12)", zIndex: 30 } },
        opciones.length === 0 && h("div", { style: { padding: "8px 10px", fontSize: 13, color: MUTED } }, items.length ? "Sin resultados" : vacio),
        opciones.map((o, i) => h("div", { key: (o.nuevo ? "nuevo:" : "") + o.nombre, role: "option", "aria-selected": i === activo,
          onMouseDown: (e) => { e.preventDefault(); elegir(o); }, onMouseEnter: () => setActivo(i),
          style: { padding: "7px 10px", fontSize: 13, cursor: "pointer", background: i === activo ? SOFT : "#fff", borderTop: o.nuevo && visibles.length ? `1px solid ${LINE}` : "none", fontWeight: o.nuevo ? 600 : 400 } }, o.nuevo ? nuevo(o.nombre) : o.nombre)),
        coincidencias.length > visibles.length && h("div", { style: { padding: "6px 10px", fontSize: 12, color: MUTED, borderTop: `1px solid ${LINE}` } }, `Mostrando ${visibles.length} de ${coincidencias.length}: sigue escribiendo para filtrar`)));
  }

  function useFormulario(inicial, guardarFn, okNuevo, okEdicion) {
    const [f, setF] = useState(inicial());
    const [editId, setEditId] = useState(null);
    const [msg, setMsg] = useState({ ok: true, t: "" });
    const [busy, setBusy] = useState(false);
    const ejecutar = async (fn, okTxt) => {
      setBusy(true); setMsg({ ok: true, t: "Guardando…" });
      try { await fn(); setMsg({ ok: true, t: okTxt }); return true; }
      catch (e) { setMsg({ ok: false, t: "No se ha guardado: " + (e.message || e) }); return false; }
      finally { setBusy(false); }
    };
    const guardar = async (datos) => {
      const ok = await ejecutar(() => guardarFn(datos, editId), editId ? okEdicion : okNuevo);
      if (ok) { setEditId(null); setF({ ...inicial(), fecha: f.fecha, iva_rate: f.iva_rate, vendedor: f.vendedor, categoria: f.categoria }); }
    };
    return { f, setF, editId, setEditId, msg, busy, ejecutar, guardar };
  }

  /* ---------- cobros ---------- */
  function PagosCaja({ caja, month }) {
    const { f, setF, editId, setEditId, msg, busy, ejecutar, guardar } = useFormulario(vacio, caja.api.guardarPago, "Cobro registrado.", "Cambios guardados.");
    const set = setter(f, setF);
    const importe = parseFloat(String(f.importe).replace(",", "."));
    const valido = f.fecha && f.cliente_nombre.trim() && f.concepto.trim() && Number.isFinite(importe) && importe > 0;
    const calc = valido ? calcIva(importe, f.iva_rate, f.incluye_iva) : null;
    const conceptoNuevo = f.concepto.trim() && !caja.conceptos.some((k) => k.nombre_norm === normName(f.concepto));
    const editar = (c) => {
      setEditId(c.id);
      setF({ fecha: c.fecha, cliente_nombre: c.cliente_nombre, concepto: c.concepto, importe: String(c.importe_cents / 100).replace(".", ","), iva_rate: Number(c.iva_rate), incluye_iva: true, vendedor: c.vendedor, sin_aimharder: c.sin_aimharder, notas: c.notas });
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    const delMes = caja.pagos.filter((c) => (c.fecha || "").startsWith(month)).sort((a, b) => b.fecha.localeCompare(a.fecha));
    const suma = (k) => delMes.reduce((a, c) => a + c[k], 0);
    const fila = (c) => h("div", { key: c.id, style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13, padding: "8px 0", borderBottom: `1px solid ${SOFT}` } },
      h("span", { style: { color: MUTED, minWidth: 78 } }, c.fecha),
      h("b", { style: { flex: "1 1 180px" } }, c.concepto, c.cliente_nombre ? ` · ${c.cliente_nombre}` : "", c.notas ? h("span", { style: { fontWeight: 400, color: MUTED } }, ` — ${c.notas}`) : null),
      c.vendedor && h("span", { style: { color: MUTED } }, c.vendedor),
      c.sin_aimharder && h("span", { style: { fontSize: 12, color: MUTED }, title: "No se empareja con ningún pago de AimHarder" }, "Sin AimHarder"),
      h("span", { style: { fontSize: 12, color: MUTED }, title: "Base imponible + IVA" }, `${eurC(c.base_cents)} + IVA ${Number(c.iva_rate)}% (${eurC(c.iva_cents)})`),
      h("b", { style: { minWidth: 80, textAlign: "right" } }, eurC(c.importe_cents)),
      caja.puedeEditar && h("button", { className: "axis-btn ghost", style: { padding: "3px 8px" }, onClick: () => editar(c) }, "Editar"),
      caja.puedeEditar && h("button", { className: "axis-btn ghost", style: { padding: "3px 8px" }, disabled: busy, "aria-label": "Eliminar cobro", onClick: () => {
        if (window.confirm(`¿Eliminar el cobro "${c.concepto}" de ${eurC(c.importe_cents)}?`)) ejecutar(() => caja.api.borrarPago(c.id), "Cobro eliminado.");
      } }, "\u{1F5D1}"));
    return h("div", { style: { display: "grid", gap: 18 } },
      caja.puedeEditar && h("section", { style: box },
        h("h2", { className: "axis-display", style: { margin: "0 0 6px", fontSize: 20, textTransform: "uppercase" } }, editId ? "Editar cobro" : "Registrar cobro"),
        h("p", { style: { margin: "0 0 12px", fontSize: 13, color: MUTED } }, "Caja de efectivo: se apunta lo que se cobra, con el IVA que lleva. La fecha y el cliente sirven para emparejarlo con el pago de AimHarder (el de 0 €); el producto, de las tarifas de AimHarder. Para un cobro aparte, crea un concepto nuevo y se marcará como «no existe en AimHarder»."),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 } },
          h("label", { style: lbl }, h("b", { style: { color: INK } }, "Fecha del cobro"), h("input", { type: "date", className: "axis-input", value: f.fecha, onChange: set("fecha") })),
          h("div", { style: lbl }, h("span", { style: { color: INK, fontWeight: 700 } }, "Cliente"), h(SelectorLista, { items: caja.clientes, value: f.cliente_nombre, placeholder: "Buscar cliente…", vacio: "Aún no hay clientes: escribe un nombre para crearlo", nuevo: (t) => `+ Crear cliente «${t}»`, onChange: (v) => setF((a) => ({ ...a, cliente_nombre: v })) })),
          h("div", { style: lbl }, h("span", { style: { color: INK, fontWeight: 700 } }, "Producto / concepto"), h(SelectorLista, { items: caja.conceptos, value: f.concepto, placeholder: "Buscar producto…", vacio: "Aún no hay conceptos: escribe uno para crearlo", nuevo: (t) => `+ Crear concepto «${t}»`,
            // Al elegir una tarifa de AimHarder se rellenan su precio e IVA habituales; un concepto nuevo/manual no existe en AimHarder.
            onChange: (v, item) => setF((a) => ({ ...a, concepto: v, ...(v ? { sin_aimharder: !item || item.origen === "manual" } : {}), ...(!item && v ? { iva_rate: ivaPorDefecto(v) } : {}), ...(item ? { iva_rate: Number(item.iva_rate), importe: item.precio_cents && !String(a.importe).trim() ? String(item.precio_cents / 100).replace(".", ",") : a.importe } : {}) })) })),
          h("label", { style: lbl }, h("b", { style: { color: INK } }, "Importe cobrado (€)"), h("input", { className: "axis-input", inputMode: "decimal", value: f.importe, onChange: set("importe"), placeholder: "0,00" })),
          campoIva(f, set),
          h("label", { style: lbl }, "Vendedor", h("select", { className: "axis-input", value: f.vendedor, onChange: set("vendedor") }, h("option", { value: "" }, "El que figure en AimHarder"), VENDEDORES.map((v) => h("option", { key: v, value: v }, v)))),
          h("label", { style: lbl }, "Notas (opcional)", h("input", { className: "axis-input", value: f.notas, onChange: set("notas") }))),
        h("label", { style: { ...lbl, display: "flex", gap: 6, alignItems: "center", marginTop: 10 } }, h("input", { type: "checkbox", checked: f.sin_aimharder, onChange: set("sin_aimharder") }), "Cobro aparte, no existe en AimHarder (cuenta en la caja pero no cubre sesiones)"),
        calc && h("p", { style: { margin: "10px 0 0", fontSize: 13 } }, "Base ", h("b", null, eurC(calc.base)), " + IVA ", h("b", null, eurC(calc.iva)), " = total cobrado ", h("b", null, eurC(calc.total))),
        conceptoNuevo && h("p", { style: { margin: "6px 0 0", fontSize: 12, color: MUTED } }, "Concepto nuevo: se guardará en la lista con este IVA y este importe como habituales."),
        h("div", { style: { marginTop: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" } },
          h("button", { className: "axis-btn primary", onClick: () => guardar({ ...f, importe }), disabled: !valido || busy }, editId ? "Guardar cambios" : "Registrar cobro"),
          editId && h("button", { className: "axis-btn ghost", onClick: () => { setEditId(null); setF(vacio()); } }, "Cancelar"),
          msg.t && h("span", { style: { fontSize: 13, color: msg.ok ? GOOD : BAD } }, msg.t))),
      h("section", { style: box },
        h("div", { style: { display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 10 } },
          h("div", null, h("div", { style: { fontSize: 12, color: MUTED } }, "Cobrado en el mes"), h("div", { className: "axis-display", style: { fontSize: 28, fontWeight: 700 } }, eurC(suma("importe_cents"))), h("div", { style: { fontSize: 12, color: MUTED } }, `${delMes.length} cobro(s)`)),
          h("div", null, h("div", { style: { fontSize: 12, color: MUTED } }, "Base imponible"), h("div", { className: "axis-display", style: { fontSize: 28, fontWeight: 700 } }, eurC(suma("base_cents")))),
          h("div", null, h("div", { style: { fontSize: 12, color: MUTED } }, "IVA repercutido"), h("div", { className: "axis-display", style: { fontSize: 28, fontWeight: 700 } }, eurC(suma("iva_cents"))))),
        delMes.length === 0 ? h("p", { style: { fontSize: 13, color: MUTED, margin: 0 } }, "No hay cobros registrados en este mes.") : h("div", null, delMes.map(fila))),
      h("details", { style: box },
        h("summary", { style: { cursor: "pointer", fontWeight: 600, fontSize: 14 } }, `Conceptos y tarifas (${caja.conceptos.length})`),
        h("p", { style: { margin: "10px 0", fontSize: 13, color: MUTED } }, "Las tarifas vienen de AimHarder (precio más habitual, con IVA incluido). El precio se propone al elegir el concepto y el IVA se aplica por defecto (fisioterapia, nutrición y psicología sin IVA; el resto al 21 %). Puedes ajustar cada uno aquí. Los conceptos nuevos se crean desde el desplegable al registrar un cobro."),
        caja.conceptos.length === 0 ? h("p", { style: { fontSize: 13, color: MUTED, margin: 0 } }, "Aún no hay conceptos.") : h("div", null, caja.conceptos.map((k) => h(FilaConcepto, { key: k.id + ":" + k.precio_cents + ":" + k.iva_rate, caja, k })))));
  }

  // Precio e IVA habituales de cada concepto (el IVA correcto depende del servicio: se ajusta aquí).
  function FilaConcepto({ caja, k }) {
    const [precio, setPrecio] = useState(k.precio_cents == null ? "" : String(k.precio_cents / 100).replace(".", ","));
    const [iva, setIva] = useState(Number(k.iva_rate));
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState("");
    const cents = precio.trim() === "" ? null : Math.round((parseFloat(precio.replace(",", ".")) || 0) * 100);
    const cambiado = cents !== k.precio_cents || iva !== Number(k.iva_rate);
    const ejecutar = async (fn, ok) => { setBusy(true); setMsg(""); try { await fn(); setMsg(ok); } catch (e) { setMsg("Error: " + (e.message || e)); } finally { setBusy(false); } };
    return h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13, padding: "6px 0", borderBottom: `1px solid ${SOFT}` } },
      h("span", { style: { flex: "1 1 220px" } }, k.nombre, k.origen === "manual" && h("span", { style: { fontSize: 11, color: MUTED } }, "  · manual")),
      h("input", { className: "axis-input", style: { width: 90 }, inputMode: "decimal", value: precio, placeholder: "Precio €", "aria-label": `Precio de ${k.nombre}`, onChange: (e) => setPrecio(e.target.value), disabled: !caja.puedeEditar }),
      h("select", { className: "axis-input", style: { width: 110 }, value: iva, "aria-label": `IVA de ${k.nombre}`, onChange: (e) => setIva(Number(e.target.value)), disabled: !caja.puedeEditar }, TIPOS_IVA.map((t) => h("option", { key: t, value: t }, t === 0 ? "0 % exento" : `${t} %`))),
      caja.puedeEditar && h("button", { className: "axis-btn ghost", style: { padding: "3px 8px" }, disabled: busy || !cambiado, onClick: () => ejecutar(() => caja.api.actualizarConcepto(k.id, { precio_cents: cents, iva_rate: iva }), "Guardado") }, "Guardar"),
      caja.puedeEditar && h("button", { className: "axis-btn ghost", style: { padding: "3px 8px" }, disabled: busy, "aria-label": `Eliminar ${k.nombre}`, onClick: () => { if (window.confirm(`¿Quitar el concepto "${k.nombre}" de la lista? Los cobros ya registrados no cambian.`)) ejecutar(() => caja.api.borrarConcepto(k.id), ""); } }, "\u{1F5D1}"),
      msg && h("span", { style: { fontSize: 12, color: msg.startsWith("Error") ? BAD : GOOD } }, msg));
  }

  /* ---------- gastos ---------- */
  function GastosCaja({ caja, month }) {
    const { f, setF, editId, setEditId, msg, busy, ejecutar, guardar } = useFormulario(vacioGasto, caja.api.guardarGasto, "Gasto registrado.", "Cambios guardados.");
    const [fCat, setFCat] = useState("");
    const [fTexto, setFTexto] = useState("");
    const set = setter(f, setF);
    const importe = parseFloat(String(f.importe).replace(",", "."));
    const valido = f.fecha && f.concepto.trim() && Number.isFinite(importe) && importe > 0;
    const calc = valido ? calcIva(importe, f.iva_rate, f.incluye_iva) : null;
    const cargarEnForm = (g, duplicar) => {
      setEditId(duplicar ? null : g.id);
      setF({ fecha: duplicar ? todayISO() : g.fecha, concepto: g.concepto, proveedor: g.proveedor, categoria: g.categoria, importe: String(g.total_cents / 100).replace(".", ","), iva_rate: Number(g.iva_rate), incluye_iva: true, factura: duplicar ? "" : g.factura, notas: g.notas });
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    const delMes = caja.gastos.filter((g) => (g.fecha || "").startsWith(month));
    const visibles = delMes.filter((g) => (!fCat || g.categoria === fCat) && (!fTexto.trim() || normName([g.concepto, g.proveedor, g.factura, g.notas].join(" ")).includes(normName(fTexto)))).sort((a, b) => b.fecha.localeCompare(a.fecha));
    const suma = (k) => delMes.reduce((a, g) => a + g[k], 0);
    const porCat = {};
    for (const g of delMes) porCat[g.categoria] = (porCat[g.categoria] || 0) + g.total_cents;
    const cats = Object.entries(porCat).sort((a, b) => b[1] - a[1]);
    const maxCat = Math.max(1, ...cats.map((c) => c[1]));
    const proveedores = [...new Set(caja.gastos.map((g) => g.proveedor).filter(Boolean))].sort();
    const conceptos = [...new Set(caja.gastos.map((g) => g.concepto))].sort();
    const fila = (g) => h("div", { key: g.id, style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13, padding: "8px 0", borderBottom: `1px solid ${SOFT}` } },
      h("span", { style: { color: MUTED, minWidth: 78 } }, g.fecha),
      h("div", { style: { flex: "1 1 200px" } },
        h("b", null, g.concepto, g.proveedor ? ` · ${g.proveedor}` : ""),
        h("div", { style: { fontSize: 12, color: MUTED } }, g.categoria, g.factura ? ` · Factura ${g.factura}` : "", g.notas ? ` — ${g.notas}` : "")),
      h("span", { style: { fontSize: 12, color: MUTED }, title: "Base imponible + IVA" }, `${eurC(g.base_cents)} + IVA ${Number(g.iva_rate)}% (${eurC(g.iva_cents)})`),
      h("b", { style: { minWidth: 80, textAlign: "right" } }, eurC(g.total_cents)),
      caja.puedeEditar && h("button", { className: "axis-btn ghost", style: { padding: "3px 8px" }, onClick: () => cargarEnForm(g, false) }, "Editar"),
      caja.puedeEditar && h("button", { className: "axis-btn ghost", style: { padding: "3px 8px" }, title: "Copiar este gasto con la fecha de hoy (p. ej. un gasto mensual)", onClick: () => cargarEnForm(g, true) }, "Duplicar"),
      caja.puedeEditar && h("button", { className: "axis-btn ghost", style: { padding: "3px 8px" }, disabled: busy, "aria-label": "Eliminar gasto", onClick: () => {
        if (window.confirm(`¿Eliminar el gasto "${g.concepto}" de ${eurC(g.total_cents)}?`)) ejecutar(() => caja.api.borrarGasto(g.id), "Gasto eliminado.");
      } }, "\u{1F5D1}"));
    return h("div", { style: { display: "grid", gap: 18 } },
      caja.puedeEditar && h("section", { style: box },
        h("h2", { className: "axis-display", style: { margin: "0 0 6px", fontSize: 20, textTransform: "uppercase" } }, editId ? "Editar gasto" : "Registrar gasto"),
        h("p", { style: { margin: "0 0 12px", fontSize: 13, color: MUTED } }, "Salidas de dinero de la caja (en efectivo). Indica si el importe ya lleva IVA o hay que sumarlo: el panel separa base e IVA."),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 } },
          h("label", { style: lbl }, h("b", { style: { color: INK } }, "Fecha del gasto"), h("input", { type: "date", className: "axis-input", value: f.fecha, onChange: set("fecha") })),
          h("label", { style: lbl }, "Concepto", h("input", { className: "axis-input", list: "caja-g-conceptos", value: f.concepto, onChange: set("concepto"), placeholder: "Ej. Material de limpieza" })),
          h("label", { style: lbl }, "Proveedor (opcional)", h("input", { className: "axis-input", list: "caja-g-proveedores", value: f.proveedor, onChange: set("proveedor") })),
          h("label", { style: lbl }, "Categoría", h("select", { className: "axis-input", value: f.categoria, onChange: set("categoria") }, CATEGORIAS_GASTO.map((c) => h("option", { key: c, value: c }, c)))),
          h("label", { style: lbl }, h("b", { style: { color: INK } }, "Importe (€)"), h("input", { className: "axis-input", inputMode: "decimal", value: f.importe, onChange: set("importe"), placeholder: "0,00" })),
          campoIva(f, set),
          h("label", { style: lbl }, "Nº de factura (opcional)", h("input", { className: "axis-input", value: f.factura, onChange: set("factura") })),
          h("label", { style: lbl }, "Notas (opcional)", h("input", { className: "axis-input", value: f.notas, onChange: set("notas") }))),
        h("datalist", { id: "caja-g-conceptos" }, conceptos.map((c) => h("option", { key: c, value: c }))),
        h("datalist", { id: "caja-g-proveedores" }, proveedores.map((c) => h("option", { key: c, value: c }))),
        calc && h("p", { style: { margin: "10px 0 0", fontSize: 13 } }, "Base ", h("b", null, eurC(calc.base)), " + IVA ", h("b", null, eurC(calc.iva)), " = total ", h("b", null, eurC(calc.total))),
        h("div", { style: { marginTop: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" } },
          h("button", { className: "axis-btn primary", onClick: () => guardar({ ...f, importe }), disabled: !valido || busy }, editId ? "Guardar cambios" : "Registrar gasto"),
          editId && h("button", { className: "axis-btn ghost", onClick: () => { setEditId(null); setF(vacioGasto()); } }, "Cancelar"),
          msg.t && h("span", { style: { fontSize: 13, color: msg.ok ? GOOD : BAD } }, msg.t))),
      h("section", { style: box },
        h("div", { style: { display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 12 } },
          h("div", null, h("div", { style: { fontSize: 12, color: MUTED } }, "Gastado en el mes"), h("div", { className: "axis-display", style: { fontSize: 28, fontWeight: 700 } }, eurC(suma("total_cents"))), h("div", { style: { fontSize: 12, color: MUTED } }, `${delMes.length} gasto(s)`)),
          h("div", null, h("div", { style: { fontSize: 12, color: MUTED } }, "Base imponible"), h("div", { className: "axis-display", style: { fontSize: 28, fontWeight: 700 } }, eurC(suma("base_cents")))),
          h("div", null, h("div", { style: { fontSize: 12, color: MUTED } }, "IVA soportado"), h("div", { className: "axis-display", style: { fontSize: 28, fontWeight: 700 } }, eurC(suma("iva_cents"))))),
        cats.length > 0 && h("div", { style: { display: "grid", gap: 5, margin: "0 0 14px" } },
          h("div", { style: { fontSize: 12, color: MUTED, textTransform: "uppercase", letterSpacing: ".04em" } }, "Por categoría"),
          cats.map(([c, v]) => h("div", { key: c, style: { display: "grid", gridTemplateColumns: "minmax(120px, 220px) 1fr 90px", gap: 8, alignItems: "center", fontSize: 12 } },
            h("span", null, c), h("div", { style: { background: SOFT, borderRadius: 4, height: 8 } }, h("div", { style: { width: `${Math.max(2, v / maxCat * 100)}%`, background: BAR_OUT, height: 8, borderRadius: 4 } })), h("b", { style: { textAlign: "right" } }, eurC(v))))),
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 } },
          h("input", { className: "axis-input", style: { maxWidth: 240 }, placeholder: "Buscar concepto, proveedor, factura…", value: fTexto, onChange: (e) => setFTexto(e.target.value), "aria-label": "Buscar gastos" }),
          h("select", { className: "axis-input", style: { maxWidth: 240 }, value: fCat, onChange: (e) => setFCat(e.target.value), "aria-label": "Filtrar por categoría" }, h("option", { value: "" }, "Todas las categorías"), CATEGORIAS_GASTO.map((c) => h("option", { key: c, value: c }, c)))),
        visibles.length === 0 ? h("p", { style: { fontSize: 13, color: MUTED, margin: 0 } }, delMes.length ? "Ningún gasto coincide con el filtro." : "No hay gastos registrados en este mes.") : h("div", null, visibles.map(fila))));
  }

  /* ---------- balance (caja de efectivo) ---------- */
  // Movimientos de la caja en céntimos: entradas (cobros) y salidas (gastos), con su IVA.
  function movimientos(pagosCaja, gastos) {
    const m = [];
    for (const c of pagosCaja) if (c.estado === "cobrado" && c.importe_cents > 0) m.push({ fecha: c.fecha, tipo: "in", cents: c.importe_cents, iva: c.iva_cents || 0, cat: catFromConcept(c.concepto), vend: c.vendedor || "Sin indicar" });
    for (const g of gastos) if (g.estado === "pagado") m.push({ fecha: g.fecha, tipo: "out", cents: g.total_cents, iva: g.iva_cents || 0, cat: g.categoria });
    return m;
  }

  // Resumen por meses de un año, con el acumulado (efectivo inicial + todo lo anterior).
  function calcularBalance(movs, config, anio, hoy) {
    const desde = (config && config.saldo_inicial_fecha) || "0000-00-00";
    const validos = movs.filter((m) => m.fecha >= desde);
    const firmado = (m) => (m.tipo === "in" ? m.cents : -m.cents);
    const inicial = (config && config.saldo_inicial_efectivo_cents) || 0;
    let acum = inicial;
    for (const m of validos) if (m.fecha.slice(0, 4) < String(anio)) acum += firmado(m);
    const apertura = acum;
    const meses = [];
    for (let i = 1; i <= 12; i++) {
      const ym = `${anio}-${String(i).padStart(2, "0")}`;
      let ent = 0, sal = 0, ivaRep = 0, ivaSop = 0;
      for (const m of validos) {
        if (m.fecha.slice(0, 7) !== ym) continue;
        if (m.tipo === "in") { ent += m.cents; ivaRep += m.iva; } else { sal += m.cents; ivaSop += m.iva; }
      }
      acum += ent - sal;
      meses.push({ ym, ent, sal, neto: ent - sal, ivaRep, ivaSop, acum });
    }
    let actual = inicial;
    for (const m of validos) if (m.fecha <= hoy) actual += firmado(m);
    return { apertura, meses, actual, desde: config && config.saldo_inicial_fecha };
  }

  function descargarCSV(nombre, filas) {
    const csv = "\uFEFF" + filas.map((f) => f.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = nombre;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const num = (c) => (c / 100).toFixed(2).replace(".", ",");

  function BalanceCaja({ caja, month, setMonth }) {
    const [cfg, setCfg] = useState({ efectivo: "", fecha: "" });
    const [msg, setMsg] = useState("");
    useEffect(() => {
      const c = caja.config;
      setCfg({ efectivo: String((c.saldo_inicial_efectivo_cents || 0) / 100).replace(".", ","), fecha: c.saldo_inicial_fecha || "" });
    }, [caja.config]);
    const anio = Number(month.slice(0, 4)), hoy = todayISO();
    const movs = useMemo(() => movimientos(caja.pagos, caja.gastos), [caja.pagos, caja.gastos]);
    const b = useMemo(() => calcularBalance(movs, caja.config, anio, hoy), [movs, caja.config, anio, hoy]);
    const sel = b.meses.find((m) => m.ym === month) || b.meses[0];
    const total = b.meses.reduce((a, m) => ({ ent: a.ent + m.ent, sal: a.sal + m.sal, ivaRep: a.ivaRep + m.ivaRep, ivaSop: a.ivaSop + m.ivaSop }), { ent: 0, sal: 0, ivaRep: 0, ivaSop: 0 });
    const max = Math.max(1, ...b.meses.map((m) => Math.max(m.ent, m.sal)));
    const delMes = movs.filter((m) => m.fecha.slice(0, 7) === sel.ym && m.fecha >= (b.desde || "0000"));
    const agrupar = (tipo, clave) => {
      const r = {};
      for (const m of delMes) if (m.tipo === tipo) r[clave(m)] = (r[clave(m)] || 0) + m.cents;
      return Object.entries(r).sort((a, c) => c[1] - a[1]);
    };
    const bloque = (titulo, datos, color) => {
      const mx = Math.max(1, ...datos.map((d) => d[1]));
      return h("div", { style: { display: "grid", gap: 5, alignContent: "start" } },
        h("div", { style: { fontSize: 12, color: MUTED, textTransform: "uppercase", letterSpacing: ".04em" } }, titulo),
        datos.length === 0 ? h("span", { style: { fontSize: 12, color: MUTED } }, "—") : datos.map(([k, v]) => h("div", { key: k, style: { display: "grid", gridTemplateColumns: "minmax(90px, 160px) 1fr 80px", gap: 8, alignItems: "center", fontSize: 12 } },
          h("span", null, k), h("div", { style: { background: SOFT, borderRadius: 4, height: 8 } }, h("div", { style: { width: `${Math.max(2, v / mx * 100)}%`, background: color, height: 8, borderRadius: 4 } })), h("b", { style: { textAlign: "right" } }, eurC(v)))));
    };
    const tarjeta = (titulo, valor, color, sub) => h("div", { style: { ...box, padding: 12, minWidth: 150, flex: "1 1 150px" } },
      h("div", { style: { fontSize: 12, color: MUTED } }, titulo), h("div", { className: "axis-display", style: { fontSize: 26, fontWeight: 700, color: color || INK } }, valor), sub && h("div", { style: { fontSize: 11, color: MUTED } }, sub));
    const guardarCfg = async () => {
      const cents = Math.round((parseFloat(String(cfg.efectivo).replace(",", ".")) || 0) * 100);
      try { await caja.api.guardarConfig({ efectivo: cents, fecha: cfg.fecha }); setMsg("Efectivo inicial guardado."); } catch (e) { setMsg("No se ha guardado: " + (e.message || e)); }
    };
    const exportar = () => descargarCSV(`balance-caja-${anio}.csv`, [
      ["Mes", "Entradas", "Salidas", "Neto", "IVA repercutido", "IVA soportado", "Acumulado"],
      ...b.meses.map((m) => [m.ym, num(m.ent), num(m.sal), num(m.neto), num(m.ivaRep), num(m.ivaSop), num(m.acum)]),
      ["Total " + anio, num(total.ent), num(total.sal), num(total.ent - total.sal), num(total.ivaRep), num(total.ivaSop), ""]]);
    const exportarMov = () => descargarCSV(`movimientos-caja-${anio}.csv`, [
      ["Fecha", "Tipo", "Concepto", "Cliente / proveedor", "Categoría", "Base", "IVA %", "IVA", "Total", "Vendedor", "Factura", "Notas"],
      ...[...caja.pagos.filter((c) => c.fecha.startsWith(String(anio))).map((c) => [c.fecha, "Cobro", c.concepto, c.cliente_nombre, "", num(c.base_cents), Number(c.iva_rate), num(c.iva_cents), num(c.importe_cents), c.vendedor, "", c.notas]),
        ...caja.gastos.filter((g) => g.fecha.startsWith(String(anio))).map((g) => [g.fecha, "Gasto", g.concepto, g.proveedor, g.categoria, num(g.base_cents), Number(g.iva_rate), num(g.iva_cents), num(g.total_cents), "", g.factura, g.notas])].sort((a, c) => a[0].localeCompare(c[0]))]);
    const th = { padding: "6px 8px", borderBottom: `2px solid ${INK}`, fontSize: 12, color: MUTED, textAlign: "right", whiteSpace: "nowrap" };
    const td = { padding: "7px 8px", borderBottom: `1px solid ${SOFT}`, fontSize: 13, textAlign: "right", whiteSpace: "nowrap" };
    const col = (v) => (v > 0 ? BAR_IN : v < 0 ? BAD : INK);
    const ivaNeto = sel.ivaRep - sel.ivaSop;

    return h("div", { style: { display: "grid", gap: 18 } },
      h("div", { style: { display: "flex", gap: 12, flexWrap: "wrap" } },
        tarjeta("Efectivo en caja ahora", eurC(b.actual), col(b.actual), `a ${hoy}`),
        tarjeta(`Entradas · ${MESES[Number(sel.ym.slice(5)) - 1]}`, eurC(sel.ent), BAR_IN, "cobros del mes"),
        tarjeta(`Salidas · ${MESES[Number(sel.ym.slice(5)) - 1]}`, eurC(sel.sal), sel.sal ? BAR_OUT : INK, "gastos del mes"),
        tarjeta("IVA del mes", eurC(ivaNeto), INK, `repercutido ${eurC(sel.ivaRep)} − soportado ${eurC(sel.ivaSop)}`)),
      h("section", { style: box },
        h("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 } },
          h("button", { className: "axis-btn ghost", onClick: () => setMonth(`${anio - 1}-${month.slice(5)}`), "aria-label": "Año anterior" }, "←"),
          h("h2", { className: "axis-display", style: { margin: 0, fontSize: 22 } }, anio),
          h("button", { className: "axis-btn ghost", onClick: () => setMonth(`${anio + 1}-${month.slice(5)}`), "aria-label": "Año siguiente" }, "→"),
          h("span", { style: { marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" } },
            h("button", { className: "axis-btn ghost", onClick: exportar }, "Descargar balance (CSV)"),
            h("button", { className: "axis-btn ghost", onClick: exportarMov }, "Descargar movimientos (CSV)"))),
        h("div", { role: "img", "aria-label": "Entradas y salidas por mes", style: { display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 4, alignItems: "end", height: 130, marginBottom: 6 } },
          b.meses.map((m, i) => h("button", { key: m.ym, onClick: () => setMonth(m.ym), title: `${MESES[i]}: entradas ${eurC(m.ent)} · salidas ${eurC(m.sal)}`, style: { all: "unset", cursor: "pointer", display: "flex", gap: 2, alignItems: "flex-end", justifyContent: "center", height: "100%", borderRadius: 4, background: m.ym === sel.ym ? SOFT : "transparent" } },
            h("div", { style: { width: "36%", height: `${m.ent / max * 100}%`, minHeight: m.ent ? 2 : 0, background: BAR_IN, borderRadius: "3px 3px 0 0" } }),
            h("div", { style: { width: "36%", height: `${m.sal / max * 100}%`, minHeight: m.sal ? 2 : 0, background: BAR_OUT, borderRadius: "3px 3px 0 0" } })))),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 4, fontSize: 11, color: MUTED, textAlign: "center", marginBottom: 12 } }, MESES.map((n) => h("span", { key: n }, n))),
        h("div", { style: { fontSize: 12, color: MUTED, marginBottom: 10 } }, h("span", { style: { color: BAR_IN } }, "■ "), "Entradas  ", h("span", { style: { color: BAR_OUT } }, "■ "), "Salidas"),
        h("div", { style: { overflowX: "auto" } }, h("table", { style: { borderCollapse: "collapse", width: "100%", minWidth: 700 } },
          h("thead", null, h("tr", null, h("th", { style: { ...th, textAlign: "left" } }, "Mes"), ["Entradas", "Salidas", "Neto del mes", "IVA repercutido", "IVA soportado", "Efectivo acumulado"].map((t) => h("th", { key: t, style: th }, t)))),
          h("tbody", null,
            h("tr", null, h("td", { style: { ...td, textAlign: "left", color: MUTED } }, `Efectivo al empezar ${anio}`), h("td", { style: td }), h("td", { style: td }), h("td", { style: td }), h("td", { style: td }), h("td", { style: td }), h("td", { style: { ...td, color: MUTED } }, eurC(b.apertura))),
            b.meses.map((m, i) => h("tr", { key: m.ym, onClick: () => setMonth(m.ym), style: { cursor: "pointer", background: m.ym === sel.ym ? SOFT : "transparent", opacity: m.ym > hoy.slice(0, 7) && !m.ent && !m.sal ? 0.5 : 1 } },
              h("td", { style: { ...td, textAlign: "left", fontWeight: m.ym === sel.ym ? 700 : 400 } }, MESES[i]),
              h("td", { style: { ...td, color: m.ent ? BAR_IN : MUTED } }, eurC(m.ent)),
              h("td", { style: { ...td, color: m.sal ? BAR_OUT : MUTED } }, eurC(m.sal)),
              h("td", { style: { ...td, fontWeight: 600, color: col(m.neto) } }, eurC(m.neto)),
              h("td", { style: { ...td, color: MUTED } }, eurC(m.ivaRep)),
              h("td", { style: { ...td, color: MUTED } }, eurC(m.ivaSop)),
              h("td", { style: { ...td, fontWeight: 700, color: col(m.acum) } }, eurC(m.acum)))),
            h("tr", null, h("td", { style: { ...td, textAlign: "left", fontWeight: 700, borderTop: `2px solid ${INK}` } }, `Total ${anio}`),
              h("td", { style: { ...td, fontWeight: 700, borderTop: `2px solid ${INK}` } }, eurC(total.ent)), h("td", { style: { ...td, fontWeight: 700, borderTop: `2px solid ${INK}` } }, eurC(total.sal)),
              h("td", { style: { ...td, fontWeight: 700, borderTop: `2px solid ${INK}`, color: col(total.ent - total.sal) } }, eurC(total.ent - total.sal)),
              h("td", { style: { ...td, fontWeight: 700, borderTop: `2px solid ${INK}` } }, eurC(total.ivaRep)), h("td", { style: { ...td, fontWeight: 700, borderTop: `2px solid ${INK}` } }, eurC(total.ivaSop)), h("td", { style: { ...td, borderTop: `2px solid ${INK}` } }))))),
        b.desde && h("p", { style: { margin: "8px 0 0", fontSize: 12, color: MUTED } }, `Se cuenta desde el ${b.desde}: lo anterior a esa fecha se ignora.`)),
      h("section", { style: box },
        h("h3", { style: { margin: "0 0 4px", fontSize: 16 } }, `${MESES[Number(sel.ym.slice(5)) - 1]} ${anio}: `, h("span", { style: { color: col(sel.neto) } }, eurC(sel.neto)), h("span", { style: { fontSize: 13, fontWeight: 400, color: MUTED } }, `  (entradas ${eurC(sel.ent)} − salidas ${eurC(sel.sal)})`)),
        h("p", { style: { margin: "0 0 12px", fontSize: 12, color: MUTED } }, `Efectivo acumulado a final de mes: ${eurC(sel.acum)}. IVA repercutido ${eurC(sel.ivaRep)} − soportado ${eurC(sel.ivaSop)} = ${eurC(ivaNeto)} ${ivaNeto >= 0 ? "a ingresar" : "a compensar"}.`),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18 } },
          bloque("Entradas por producto", agrupar("in", (m) => m.cat), BAR_IN),
          bloque("Entradas por vendedor", agrupar("in", (m) => m.vend), BAR_IN),
          bloque("Salidas por categoría", agrupar("out", (m) => m.cat), BAR_OUT)),
        h("p", { style: { margin: "12px 0 0", fontSize: 12, color: MUTED } }, "Es una caja de efectivo: cada cobro y cada gasto se cuenta en su fecha. El IVA es el que indicas al apuntar cada importe.")),
      caja.esAdmin && h("details", { style: box },
        h("summary", { style: { cursor: "pointer", fontWeight: 600, fontSize: 14 } }, "Efectivo inicial de la caja"),
        h("p", { style: { margin: "10px 0", fontSize: 13, color: MUTED } }, "Con cuánto efectivo empieza a contar el acumulado. Si indicas una fecha, solo se cuentan los movimientos desde ese día (todo lo anterior se ignora)."),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, maxWidth: 420 } },
          h("label", { style: lbl }, "Efectivo inicial (€)", h("input", { className: "axis-input", inputMode: "decimal", value: cfg.efectivo, onChange: (e) => setCfg({ ...cfg, efectivo: e.target.value }) })),
          h("label", { style: lbl }, "Contar desde (opcional)", h("input", { type: "date", className: "axis-input", value: cfg.fecha, onChange: (e) => setCfg({ ...cfg, fecha: e.target.value }) }))),
        h("div", { style: { marginTop: 10, display: "flex", gap: 12, alignItems: "center" } }, h("button", { className: "axis-btn primary", onClick: guardarCfg }, "Guardar"), msg && h("span", { style: { fontSize: 13, color: GOOD } }, msg))));
  }

  /* ---------- contenedor: acceso, cabecera y subpestañas ---------- */
  function CajaTab({ caja, month, setMonth }) {
    const [sub, setSub] = useState(() => { try { return localStorage.getItem("axis-caja-sub") || "pagos"; } catch (e) { return "pagos"; } });
    const elegir = (id) => { setSub(id); try { localStorage.setItem("axis-caja-sub", id); } catch (e) { /* sin guardar */ } };

    if (caja.estado === "cargando") return h("div", { style: { padding: "18px 22px" } }, h("p", { style: { color: MUTED, fontSize: 13 } }, "Conectando con la Caja…"));
    if (caja.estado === "sin-sesion" || caja.estado === "error" && !caja.sesion) {
      return h("div", { style: { padding: "0 22px 30px" } }, h("section", { style: box },
        h("h2", { className: "axis-display", style: { margin: "0 0 6px", fontSize: 20, textTransform: "uppercase" } }, "Acceso"),
        h("p", { style: { margin: "0 0 12px", fontSize: 13, color: MUTED } }, "Entra con tu usuario para ver y registrar los cobros, los gastos y el balance de la caja. Los cambios se ven al instante en todos los dispositivos."),
        caja.error && h("p", { style: { fontSize: 13, color: BAD } }, caja.error),
        caja.estado === "sin-sesion" && h(Login, { caja })));
    }
    if (caja.estado === "sin-acceso") {
      return h("div", { style: { padding: "0 22px 30px" } }, h("section", { style: box },
        h("p", { style: { margin: "0 0 10px", fontSize: 14 } }, `Has entrado como ${caja.sesion.user.email}, pero ese usuario no tiene acceso a la Caja. Pide que te añadan.`),
        h("button", { className: "axis-btn ghost", onClick: () => caja.api.salir() }, "Salir")));
    }
    return h("div", { style: { padding: "0 22px 30px", display: "grid", gap: 18 } },
      h("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", paddingTop: 14 } },
        sub !== "balance" && h(React.Fragment, null,
          h("button", { className: "axis-btn ghost", onClick: () => setMonth(shiftMonth(month, -1)), "aria-label": "Mes anterior" }, "←"),
          h("input", { type: "month", className: "axis-input", style: { width: 160 }, value: month, onChange: (e) => e.target.value && setMonth(e.target.value) }),
          h("button", { className: "axis-btn ghost", onClick: () => setMonth(shiftMonth(month, 1)), "aria-label": "Mes siguiente" }, "→")),
        h("span", { style: { marginLeft: "auto", fontSize: 12, color: caja.desactualizado ? WARN : MUTED } },
          caja.desactualizado ? "⚠ Sin conexión con la Caja: datos guardados · " : caja.enVivo ? "● En tiempo real · " : "Conectando… · ",
          caja.sesion.user.email, ` (${caja.rol}) `, h("button", { className: "axis-btn ghost", style: { padding: "2px 8px", marginLeft: 6 }, onClick: () => caja.api.salir() }, "Salir"))),
      h("div", { role: "tablist", "aria-label": "Secciones de la Caja", style: { display: "flex", gap: 6, flexWrap: "wrap" } },
        [["pagos", "Cobros"], ["gastos", "Gastos"], ["balance", "Balance"]].map(([id, t]) => h("button", { key: id, role: "tab", "aria-selected": sub === id, className: "axis-btn", onClick: () => elegir(id), style: { padding: "6px 16px", background: sub === id ? INK : "#fff", color: sub === id ? "#fff" : INK, border: "1px solid #C9D2CD" } }, t))),
      caja.error && h("p", { style: { margin: 0, fontSize: 13, color: BAD } }, caja.error),
      sub === "pagos" && h(PagosCaja, { caja, month }),
      sub === "gastos" && h(GastosCaja, { caja, month }),
      sub === "balance" && h(BalanceCaja, { caja, month, setMonth }));
  }

  function App() {
    const caja = useCaja();
    const [month, setMonth] = useState(todayISO().slice(0, 7));
    return h("div", { style: { maxWidth: 1100, margin: "0 auto" } },
      h("header", { style: { padding: "18px 22px 0" } }, h("h1", { className: "axis-display", style: { margin: 0, fontSize: 26, textTransform: "uppercase" } }, "Caja de Axis")),
      h(CajaTab, { caja, month, setMonth }));
  }

  window.CajaAxis = { calcIva, movimientos, calcularBalance, CajaTab, SelectorLista }; // para las pruebas
  const raiz = document.getElementById("root");
  if (raiz) ReactDOM.createRoot(raiz).render(h(App));
})();
