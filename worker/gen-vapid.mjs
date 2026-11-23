// Jalankan sekali:  node gen-vapid.mjs
// Hasilnya dipasang sebagai secret di Worker (lihat PUSH-SETUP.md). Jangan commit/bagikan VAPID_PRIVATE_JWK.
import { generateKeyPairSync } from "node:crypto";
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
const b = (s) => Buffer.from(s, "base64url");
const pub = Buffer.concat([Buffer.from([4]), b(jwk.x), b(jwk.y)]).toString("base64url");
console.log("VAPID_PUBLIC=" + pub);
console.log("VAPID_PRIVATE_JWK=" + JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }));
