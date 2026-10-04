'use strict';
/*
 * Minimal S3 client (AWS Signature V4) for Cloudflare R2 or any S3-compatible
 * storage. Only what the lyrics server needs: PUT / GET / DELETE of one object.
 */
const crypto = require('node:crypto');

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
/* RFC 3986 encoding of each path segment, as SigV4 requires. */
const encodeKey = key => key.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');

class S3Bucket {
  /**
   * @param {{endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string, region?: string, timeoutMs?: number}} options
   */
  constructor(options) {
    this.endpoint = new URL(options.endpoint);
    this.bucket = options.bucket;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.region = options.region || 'auto';
    this.timeoutMs = options.timeoutMs || 15000;
  }

  static fromEnv(env) {
    const bucket = env.R2_BUCKET, accessKeyId = env.R2_ACCESS_KEY_ID, secretAccessKey = env.R2_SECRET_ACCESS_KEY;
    const endpoint = env.R2_ENDPOINT || (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
    if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) return null;
    return new S3Bucket({ endpoint, bucket, accessKeyId, secretAccessKey, region: env.R2_REGION || 'auto' });
  }

  async _request(method, key, body, headers = {}) {
    const payload = body == null ? '' : body;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const base = this.endpoint.pathname.replace(/\/+$/, '');
    const path = `${base}/${encodeURIComponent(this.bucket)}/${encodeKey(key)}`;
    const all = { ...headers, host: this.endpoint.host, 'x-amz-content-sha256': sha256(payload), 'x-amz-date': amzDate };
    const names = Object.keys(all).map(n => n.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const canonicalHeaders = names.map(n => `${n}:${lower[n]}\n`).join('');
    const signedHeaders = names.join(';');
    const canonical = [method, path, '', canonicalHeaders, signedHeaders, lower['x-amz-content-sha256']].join('\n');
    const scope = `${day}/${this.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const key4 = hmac(hmac(hmac(hmac('AWS4' + this.secretAccessKey, day), this.region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', key4).update(toSign).digest('hex');
    const send = { ...lower };
    delete send.host;
    send.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const url = `${this.endpoint.protocol}//${this.endpoint.host}${path}`;
    return fetch(url, { method, headers: send, body: method === 'PUT' ? payload : undefined, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  async put(key, body, contentType = 'application/json; charset=utf-8', metadata = {}) {
    const headers = { 'content-type': contentType };
    for (const [name, value] of Object.entries(metadata)) headers[`x-amz-meta-${name}`] = value;
    const response = await this._request('PUT', key, Buffer.from(body, 'utf8'), headers);
    if (!response.ok) throw new Error(`R2 PUT ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  /** @returns {Promise<string|null>} object body, or null when it does not exist */
  async get(key) {
    const response = await this._request('GET', key, null);
    if (response.status === 404) { await response.arrayBuffer().catch(() => {}); return null; }
    if (!response.ok) throw new Error(`R2 GET ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.text();
  }

  async delete(key) {
    const response = await this._request('DELETE', key, null);
    if (!response.ok && response.status !== 404) throw new Error(`R2 DELETE ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

module.exports = { S3Bucket, encodeKey };
