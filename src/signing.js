import { createHmac } from 'node:crypto';
import { digestJson, signatureMaterial } from './domain.js';

// 真实签名密钥只从运行环境读取，不入库、不入代码。
// 签名值 = HMAC-SHA256(secret, materialDigest)，
// 因此签名只能覆盖签署时可见的那份材料版本。
export function secretFromEnv(name = 'HAZWASTE_SIGNING_SECRET') {
  const secret = process.env[name];
  if (!secret) throw new Error(`运行环境未提供签名密钥 ${name}`);
  return secret;
}

export function buildSignature(manifest, { type, segmentId = null, role, party = null, by = null, secret, at = null }) {
  const material = signatureMaterial(manifest, type, segmentId);
  const materialDigest = digestJson(material);
  const value = createHmac('sha256', secret).update(materialDigest).digest('hex');
  return { value, materialDigest, role, party, by, at };
}

export function hmacVerifier(secret) {
  return (sig, materialDigest) =>
    createHmac('sha256', secret).update(materialDigest).digest('hex') === sig.value;
}
