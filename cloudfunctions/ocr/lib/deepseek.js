const https = require('https');
const { URL } = require('url');

/**
 * 调用 DeepSeek（OpenAI 兼容）视觉接口。
 * 环境变量：
 *   DEEPSEEK_API_KEY  必填
 *   DEEPSEEK_BASE_URL 默认 https://api.deepseek.com
 *   DEEPSEEK_MODEL    默认 deepseek-chat（需切到支持图片输入的模型）
 */
function chatVision({ messages, timeoutMs = 120000, responseFormat = null }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return Promise.reject(new Error('OCR_NOT_CONFIGURED: 未配置 DEEPSEEK_API_KEY'));
  }
  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const url = new URL('/chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);

  const body = {
    model,
    messages,
    temperature: 0,
    max_tokens: Number(process.env.DEEPSEEK_MAX_TOKENS || 8000),
    stream: false,
  };
  if (responseFormat) body.response_format = responseFormat;

  const data = Buffer.from(JSON.stringify(body));

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': data.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // 不回传密钥；只保留截断后的错误体便于排查
            reject(new Error(`DEEPSEEK_HTTP_${res.statusCode}: ${text.slice(0, 300)}`));
            return;
          }
          try {
            const json = JSON.parse(text);
            const content = json.choices && json.choices[0] && json.choices[0].message
              ? json.choices[0].message.content
              : '';
            if (!content) {
              reject(new Error('DEEPSEEK_EMPTY_RESPONSE'));
              return;
            }
            resolve(content);
          } catch (e) {
            reject(new Error(`DEEPSEEK_BAD_RESPONSE: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('DEEPSEEK_TIMEOUT')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = { chatVision };
