// ═══════════════════════════════════════════════════════════════════════════
// PERMISOS — per-person capabilities (new file: permisos.gs)
//
// Who may do what is decided by CAPABILITIES, not by hardcoded names in each
// feature. A capability is a true/false switch (or a list / number) with a
// dotted name, e.g. 'finance.view_totals'.
//
// Resolution order, per capability (later steps override earlier ones):
//   1. admin role                      -> everything allowed (not overridable)
//   2. ROLE_CAPS.staff                 -> defaults for every staff person
//   3. USER_CAPS[NAME]                 -> per-person switches in code (below)
//   4. Script Property CAPS_<NAME>     -> JSON overrides saved from the
//                                         Finanzas > Configuración screen
//                                         (no code edit, no redeploy)
//
// To give Karin access to something later, do ONE of:
//   a) tick it in Finanzas > Configuración > Permisos (recommended), or
//   b) flip the value in USER_CAPS.KARIN below and redeploy.
//
// The server enforces these on every request; the browser only uses the same
// list to hide buttons. Machine identities (VPS, Shopify webhook) never get
// any capability here.
// ═══════════════════════════════════════════════════════════════════════════

const FIN_SCOPES = ['operativo', 'fijo', 'nomina', 'confidencial'];

// Every capability, in the order the Permisos screen lists them.
// type: bool | scopes | days.   def_staff = value a brand-new staff person gets.
const CAP_DEFS = [
  { key: 'finance.view',             type: 'bool',   group: 'Acceso',      label: 'Abrir la pestaña Finanzas' },
  { key: 'finance.create',           type: 'bool',   group: 'Gastos',      label: 'Agregar gastos, fotos y líneas' },
  { key: 'finance.edit_own',         type: 'bool',   group: 'Gastos',      label: 'Editar lo que ella misma capturó (mes abierto)' },
  { key: 'finance.edit_any',         type: 'bool',   group: 'Gastos',      label: 'Editar gastos de cualquiera / marcar Revisado' },
  { key: 'finance.view_all_entries', type: 'bool',   group: 'Gastos',      label: 'Ver gastos capturados por otras personas' },
  { key: 'finance.void',             type: 'bool',   group: 'Gastos',      label: 'Anular gastos y facturas' },
  { key: 'finance.scopes',           type: 'scopes', group: 'Alcance',     label: 'Categorías visibles (alcance)' },
  { key: 'finance.history_days',     type: 'days',   group: 'Alcance',     label: 'Días hacia atrás que puede consultar (0 = todo)' },
  { key: 'finance.invoices',         type: 'bool',   group: 'Facturas',    label: 'Subir XML/PDF, vincular y dar seguimiento a facturas' },
  { key: 'finance.vendors_create',   type: 'bool',   group: 'Proveedores', label: 'Crear proveedores nuevos (quedan por revisar)' },
  { key: 'finance.vendors_edit',     type: 'bool',   group: 'Proveedores', label: 'Editar y aprobar proveedores' },
  { key: 'finance.categories_edit',  type: 'bool',   group: 'Proveedores', label: 'Administrar categorías' },
  { key: 'finance.petty_cash',       type: 'bool',   group: 'Dinero',      label: 'Ver su propia caja chica' },
  { key: 'finance.reimburse',        type: 'bool',   group: 'Dinero',      label: 'Marcar reembolsos como pagados / fondear caja chica' },
  { key: 'finance.view_totals',      type: 'bool',   group: 'Totales',     label: 'Ver totales y sumas (fila de totales, KPIs)' },
  { key: 'finance.view_summary',     type: 'bool',   group: 'Totales',     label: 'Ver Resumen mensual y gráficas' },
  { key: 'finance.recurring',        type: 'bool',   group: 'Admin',       label: 'Gastos fijos (renta, suscripciones, etc.)' },
  { key: 'finance.payroll',          type: 'bool',   group: 'Admin',       label: 'Nómina' },
  { key: 'finance.month_close',      type: 'bool',   group: 'Admin',       label: 'Cerrar o reabrir un mes' },
  { key: 'finance.export',           type: 'bool',   group: 'Admin',       label: 'Exportar para el contador' },
  { key: 'finance.ai_prefill',       type: 'bool',   group: 'Admin',       label: 'Leer tickets con IA (cuesta dinero)' },
];

const ROLE_CAPS = {
  admin: '*',          // admins always get everything
  staff: {},           // staff get NO finance access unless listed below
};

// Per-person switches. Names are the USER_<NAME> Script Property suffix, UPPERCASE.
const USER_CAPS = {
  KARIN: {
    'finance.view': true,
    'finance.create': true,
    'finance.edit_own': true,
    'finance.edit_any': false,
    'finance.view_all_entries': true,   // all 'operativo' entries, not only her own
    'finance.void': false,
    'finance.scopes': ['operativo'],    // add 'fijo' later to open rent/subscriptions
    'finance.history_days': 60,
    'finance.invoices': true,
    'finance.vendors_create': true,
    'finance.vendors_edit': false,
    'finance.categories_edit': false,
    'finance.petty_cash': true,
    'finance.reimburse': false,
    'finance.view_totals': false,       // <- the "no monthly overview" switch
    'finance.view_summary': false,
    'finance.recurring': false,
    'finance.payroll': false,
    'finance.month_close': false,
    'finance.export': false,
    'finance.ai_prefill': false,
  },
};

function capDef_(key) {
  for (let i = 0; i < CAP_DEFS.length; i++) if (CAP_DEFS[i].key === key) return CAP_DEFS[i];
  return null;
}

function adminCaps_() {
  const out = { _admin: true };
  CAP_DEFS.forEach(d => {
    if (d.type === 'bool') out[d.key] = true;
    else if (d.type === 'scopes') out[d.key] = FIN_SCOPES.slice();
    else if (d.type === 'days') out[d.key] = 0;   // 0 = unlimited
  });
  return out;
}

// Keeps only known capability keys with a value of the right type, so a typo
// in USER_CAPS or in a saved override can never create a surprise permission.
function cleanCaps_(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  CAP_DEFS.forEach(d => {
    if (!(d.key in raw)) return;
    const v = raw[d.key];
    if (d.type === 'bool') out[d.key] = v === true;
    else if (d.type === 'scopes') out[d.key] = (Array.isArray(v) ? v : []).filter(s => FIN_SCOPES.indexOf(s) >= 0);
    else if (d.type === 'days') out[d.key] = Math.max(0, Math.floor(Number(v) || 0));
  });
  return out;
}

function personKey_(identity) {
  return String((identity && identity.name) || '').toUpperCase();
}

// Saved overrides for one person (the JSON the Permisos screen writes).
function capOverrides_(name) {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty('CAPS_' + name);
    return raw ? cleanCaps_(JSON.parse(raw)) : {};
  } catch (e) {
    Logger.log('capOverrides_: bad JSON in CAPS_' + name);   // TROUBLESHOOT: open Script Properties, fix or delete the CAPS_<NAME> value
    return {};
  }
}

// The fully resolved capability object for a request identity.
function resolveCaps(identity) {
  if (!identity) return {};
  if (identity.service) return {};                       // machines never get finance caps
  if (identity.role === 'admin') return adminCaps_();
  const name = personKey_(identity);
  const out = Object.assign({}, cleanCaps_(ROLE_CAPS.staff));
  Object.assign(out, cleanCaps_(USER_CAPS[name]));
  Object.assign(out, capOverrides_(name));
  return out;
}

function can(identity, cap) {
  const v = resolveCaps(identity)[cap];
  if (v === true) return true;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return true;   // a number cap (history_days) only limits; presence is enough
  return false;
}

// Value of a list/number capability with a fallback.
function capValue(identity, cap, fallback) {
  const v = resolveCaps(identity)[cap];
  return v === undefined ? fallback : v;
}

// What the browser receives in ping/whoami/bootstrap. Admins get a short
// marker plus the full object so the UI code has ONE shape to read.
function capsForClient(identity) {
  if (!identity) return {};
  const c = resolveCaps(identity);
  c._role = identity.role;
  return c;
}
