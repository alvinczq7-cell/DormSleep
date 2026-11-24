// 标准密码学工具（仅使用 Web Crypto 标准原语：HMAC-SHA256 + RFC 4226 6位截断 + SHA-256）
// 注意：本模块与 mock-bridge/server.py 中的 Python 实现完全字节级等价，
// 保证电脑端在完全断网/离线状态下计算的 6 位应急码与手机端本地校验结果 100% 一致。

const encoder = new TextEncoder();

export function buildCanonicalEmergencyPayload({
  pairId,
  sessionId,
  requestId,
  actionType,
  targetAppId,
}) {
  const normalizedTarget = actionType === 'END_TONIGHT' ? 'ALL' : (targetAppId || 'ALL');
  return `${pairId}|${sessionId}|${requestId.trim().toUpperCase()}|${actionType}|${normalizedTarget}`;
}

export async function deriveOfflineEmergencyCode({
  sharedSecret,
  pairId,
  sessionId,
  requestId,
  actionType,
  targetAppId,
}) {
  if (!sharedSecret || !pairId || !sessionId || !requestId || !actionType) {
    throw new Error('缺少派生离线应急码所需的绑定参数');
  }
  const keyData = encoder.encode(sharedSecret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const payload = buildCanonicalEmergencyPayload({
    pairId,
    sessionId,
    requestId,
    actionType,
    targetAppId,
  });

  const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(payload));
  const digest = new Uint8Array(sigBuffer);

  // 标准 RFC 4226 Dynamic Truncation（6 位数字）
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 1000000).padStart(6, '0');
}

export function formatSixDigitCode(code) {
  if (!code || code.length !== 6) return code || '------';
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
