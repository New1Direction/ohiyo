// Literal provenance validation, not a claim that a page or its interpretation is true.
export const comparisonInstructions = `For this admission final output MUST be a single strict JSON object (no markdown):
{"title":"...","requirements":["..."],"options":[{"name":"...","evidence_ids":["e-..."],"unknowns":["Delivery eligibility"],"attributes":[{"label":"...","value":"...","evidence_id":"e-...","quote":"..."}],"price":null}]}.
Every option must have name, evidence_ids, unknowns, attributes and price. List captured evidence IDs even when
no useful facts were found; use [] for a blocked page. unknowns lists unverified field names, not factual claims
(at most 20 names of 80 characters). Facts must cite that option's evidence_ids (at most 5).
price is null when unknown, otherwise
{"amount":FACT,"currency":FACT,"billing":FACT,"shipping":null,"tax":null} where FACT has exactly
{label,value,evidence_id,quote} as above. shipping/tax may instead be FACTs when known.
Amount/shipping/tax values must be original nonnegative decimal strings, currency and billing must retain
the original source wording. Every fact value must occur literally in its exact quote and that quote
must occur in saved page text. Cite evidence IDs returned by read_public_page only. Omit unsupported
attributes; use null for unknown prices/shipping/tax. Do not supply totals, conversions, source URLs,
capture times or other keys. No currency arithmetic. Titles, requirements and names are organizational
text, not verified facts. Limits: 200 character title/name/label, 20 requirements of 500 characters,
10 options, 30 attributes per option, 500 character values, 2000 character quotes, 64000 byte JSON.`;

const fail = () => { throw new Error('Comparison failed literal evidence or schema validation.'); };
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail();
}
function string(value, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) fail();
  return value;
}
function list(value, max, map) {
  if (!Array.isArray(value) || value.length > max) fail();
  return value.map(map);
}

// Original decimal precision, no binary floating-point rounding or FX inference.
function twelveMonths(price) {
  if (!price || !/^[A-Z]{3}$/.test(price.currency.value)
    || !/^(monthly|per month|\/month|\/mo)$/i.test(price.billing.value.trim())) return null;
  const decimals = price.amount.value.split('.')[1]?.length ?? 0;
  const scaled = (BigInt(price.amount.value.replace('.', '')) * 12n).toString().padStart(decimals + 1, '0');
  const amount = decimals ? `${scaled.slice(0, -decimals)}.${scaled.slice(-decimals)}`.replace(/0+$/, '').replace(/\.$/, '') : scaled;
  return { amount, currency: price.currency.value };
}

export async function validateComparison(text, receiptFor) {
  if (Buffer.byteLength(text) > 64000) fail();
  const input = JSON.parse(text);
  object(input, ['title', 'requirements', 'options']);
  const fact = async value => {
    object(value, ['label', 'value', 'evidence_id', 'quote']);
    string(value.label, 200); string(value.value, 500); string(value.quote, 2000);
    if (!/^e-[a-f0-9]{64}$/.test(value.evidence_id)) fail();
    const receipt = await receiptFor(value.evidence_id);
    if (typeof receipt?.text !== 'string' || !receipt.text.includes(value.quote)
      || !value.quote.includes(value.value) || typeof receipt.url !== 'string'
      || typeof receipt.capturedAt !== 'string') fail();
    return { ...value, source_url: receipt.url, captured_at: receipt.capturedAt };
  };
  const money = async value => {
    const result = await fact(value);
    if (!/^(0|[1-9]\d{0,11})(\.\d{1,4})?$/.test(result.value)) fail();
    // Do not accept a numeric substring of another amount (e.g. 9 from 19.99).
    const escaped = result.value.replace('.', '\\.');
    if (!new RegExp(`(?<![\\d.,])${escaped}(?![\\d.,])`).test(result.quote)) fail();
    return result;
  };
  const result = { title: string(input.title, 200),
    requirements: list(input.requirements, 20, v => string(v, 500)),
    options: await Promise.all(list(input.options, 10, async option => {
      object(option, ['name', 'evidence_ids', 'unknowns', 'attributes', 'price']);
      const evidenceIds = list(option.evidence_ids, 5, id => {
        if (typeof id !== 'string' || !/^e-[a-f0-9]{64}$/.test(id)) fail();
        return id;
      });
      const sources = await Promise.all([...new Set(evidenceIds)].map(async id => {
        const receipt = await receiptFor(id);
        if (typeof receipt?.url !== 'string' || typeof receipt.capturedAt !== 'string') fail();
        return { evidence_id: id, url: receipt.url, captured_at: receipt.capturedAt, limitations: receipt.limitations ?? [] };
      }));
      let price = null;
      if (option.price !== null) {
        object(option.price, ['amount', 'currency', 'billing', 'shipping', 'tax']);
        price = { amount: await money(option.price.amount), currency: await fact(option.price.currency),
          billing: await fact(option.price.billing),
          shipping: option.price.shipping === null ? null : await money(option.price.shipping),
          tax: option.price.tax === null ? null : await money(option.price.tax) };
      }
      const attributes = await Promise.all(list(option.attributes, 30, fact));
      const facts = [...attributes, ...Object.values(price ?? {}).filter(Boolean)];
      if (facts.some(f => !evidenceIds.includes(f.evidence_id))) fail();
      return { name: string(option.name, 200), sources, unknowns: list(option.unknowns, 20, v => string(v, 80)), attributes, price,
        annualized_monthly: twelveMonths(price) };
    })) };
  if (!result.options.length || Buffer.byteLength(JSON.stringify(result)) > 256000) fail();
  return result;
}

export function comparisonContent(comparison) {
  const render = f => `${f.label}: ${f.value} — “${f.quote}” (${f.evidence_id}; ${f.source_url}; captured ${f.captured_at})`;
  return [comparison.title, ...comparison.requirements.map(r => `Requirement: ${r}`),
    ...comparison.options.flatMap(o => [o.name, ...o.attributes.map(render),
      ...o.unknowns.map(field => `${field}: unknown`),
      ...o.sources.flatMap(s => [`Source: ${s.url} (${s.evidence_id}; captured ${s.captured_at})`, ...s.limitations]),
      ...(o.price ? ['amount', 'currency', 'billing', 'shipping', 'tax'].map(k => o.price[k]
        ? render(o.price[k]) : `${k}: unknown`) : ['Price: unknown']),
      ...(o.annualized_monthly ? [`Calculated 12 months at this monthly rate: ${o.annualized_monthly.currency} ${o.annualized_monthly.amount}. Not an advertised annual plan; additional charges remain unverified.`] : [])]),
    'Literal source excerpts only; not independent verification. No delivered totals or currency conversions calculated.'].join('\n');
}
