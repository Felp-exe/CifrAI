// Validador de parâmetros das ferramentas (um subconjunto simples de "JSON Schema").
// Toda chamada de ferramenta passa por aqui ANTES de executar: o modelo (ou o assistente local)
// não consegue passar parâmetros fora do que foi declarado.
//
// Tipos aceitos: string, integer, number, boolean, array, object.
// Regras aceitas: enum, minimum, maximum, minLength, maxLength, pattern, items, maxItems, minItems,
//                 properties, required, default, additionalProperties (sempre tratado como false).

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function check(schema, value, path, errors) {
  const t = typeOf(value);
  const ok = schema.type === 'number' ? (t === 'number' || t === 'integer') : t === schema.type;
  if (!ok) { errors.push(`${path}: esperado ${schema.type}, recebido ${t}`); return value; }

  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: deve ser um destes valores: ${schema.enum.join(', ')}`);
  if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: texto curto demais`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: texto longo demais (máx. ${schema.maxLength})`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: formato inválido`);
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: mínimo ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: máximo ${schema.maximum}`);
  }
  if (schema.type === 'array') {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: no máximo ${schema.maxItems} itens`);
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: pelo menos ${schema.minItems} item(ns)`);
    if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
  }
  if (schema.type === 'object') return checkObject(schema, value, path, errors);
  return value;
}

function checkObject(schema, value, path, errors) {
  const props = schema.properties || {};
  const result = {};
  for (const key of Object.keys(value)) {
    if (!(key in props)) { errors.push(`${path}${path ? '.' : ''}${key}: parâmetro desconhecido`); continue; }
    result[key] = check(props[key], value[key], `${path}${path ? '.' : ''}${key}`, errors);
  }
  for (const [key, def] of Object.entries(props)) {
    if (result[key] === undefined && def.default !== undefined) result[key] = def.default;
  }
  for (const key of schema.required || []) {
    if (value[key] === undefined) errors.push(`${path}${path ? '.' : ''}${key}: parâmetro obrigatório`);
  }
  return result;
}

/**
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 * `value` é uma cópia limpa, só com os parâmetros declarados (mais os valores padrão).
 */
export function validateParams(schema, params) {
  if (params === undefined || params === null) params = {};
  if (typeOf(params) !== 'object') return { ok: false, errors: ['os parâmetros devem ser um objeto'] };
  const errors = [];
  const value = checkObject(schema, params, '', errors);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
