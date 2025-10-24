const encoder = new TextEncoder();
const decoder = new TextDecoder();

const base64url = (input) => {
	const str = btoa(String.fromCharCode(...new Uint8Array(input)));
	return str.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
};

const base64urlDecode = (str) => {
	str = str.replace(/-/g, '+').replace(/_/g, '/');
	while (str.length % 4) str += '=';
	return Uint8Array.from(atob(str), c => c.charCodeAt(0));
};

const jwtUtils = {
	async generateToken(c, payload, expiresInSeconds) {
		try {
			console.log('[JWT-生成] 开始生成Token', { 
				payload, 
				expiresInSeconds,
				hasJwtSecret: !!c.env.jwt_secret 
			});

			const header = {
				alg: 'HS256',
				typ: 'JWT'
			};

			const now = Math.floor(Date.now() / 1000);
			const exp = expiresInSeconds ? now + expiresInSeconds : undefined;

			const fullPayload = {
				...payload,
				iat: now,
				...(exp ? { exp } : {})
			};

			console.log('[JWT-生成] Payload构建完成', { 
				fullPayload, 
				hasExpiration: !!exp 
			});

			const headerStr = base64url(encoder.encode(JSON.stringify(header)));
			const payloadStr = base64url(encoder.encode(JSON.stringify(fullPayload)));
			const data = `${headerStr}.${payloadStr}`;

			console.log('[JWT-生成] Header和Payload编码完成', {
				headerLength: headerStr.length,
				payloadLength: payloadStr.length
			});

			const key = await crypto.subtle.importKey(
				'raw',
				encoder.encode(c.env.jwt_secret),
				{ name: 'HMAC', hash: 'SHA-256' },
				false,
				['sign']
			);

			console.log('[JWT-生成] 密钥导入成功');

			const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
			const signatureStr = base64url(signature);

			const token = `${data}.${signatureStr}`;
			console.log('[JWT-生成] Token生成成功', { 
				tokenLength: token.length,
				tokenPrefix: token.substring(0, 20) + '...'
			});

			return token;
		} catch (error) {
			console.error('[JWT-生成] Token生成失败', {
				errorMessage: error.message,
				errorStack: error.stack,
				errorName: error.name,
				payload
			});
			throw error;
		}
	},

	async verifyToken(c, token) {
		console.log('[JWT-验证] 开始验证Token', { 
			tokenLength: token?.length || 0,
			tokenPrefix: token?.substring(0, 20) + '...',
			hasJwtSecret: !!c.env.jwt_secret
		});

		try {
			const [headerB64, payloadB64, signatureB64] = token.split('.');

			console.log('[JWT-验证] Token分割结果', {
				hasHeader: !!headerB64,
				hasPayload: !!payloadB64,
				hasSignature: !!signatureB64,
				headerLength: headerB64?.length || 0,
				payloadLength: payloadB64?.length || 0,
				signatureLength: signatureB64?.length || 0
			});

			if (!headerB64 || !payloadB64 || !signatureB64) {
				console.warn('[JWT-验证] Token格式无效，缺少必要部分');
				return null;
			}

			const data = `${headerB64}.${payloadB64}`;
			
			console.log('[JWT-验证] 开始导入验证密钥');
			const key = await crypto.subtle.importKey(
				'raw',
				encoder.encode(c.env.jwt_secret),
				{ name: 'HMAC', hash: 'SHA-256' },
				false,
				['verify']
			);
			console.log('[JWT-验证] 验证密钥导入成功');

			console.log('[JWT-验证] 开始验证签名');
			const valid = await crypto.subtle.verify(
				'HMAC',
				key,
				base64urlDecode(signatureB64),
				encoder.encode(data)
			);

			console.log('[JWT-验证] 签名验证结果', { valid });

			if (!valid) {
				console.warn('[JWT-验证] 签名验证失败');
				return null;
			}

			console.log('[JWT-验证] 开始解码Payload');
			const payloadJson = decoder.decode(base64urlDecode(payloadB64));
			const payload = JSON.parse(payloadJson);

			console.log('[JWT-验证] Payload解码成功', { 
				payload,
				hasExp: !!payload.exp,
				iat: payload.iat
			});

			const now = Math.floor(Date.now() / 1000);
			if (payload.exp && payload.exp < now) {
				console.warn('[JWT-验证] Token已过期', {
					exp: payload.exp,
					now,
					expiredSeconds: now - payload.exp
				});
				return null;
			}

			console.log('[JWT-验证] Token验证成功', { 
				emailId: payload.emailId 
			});

			return payload;

		} catch (err) {
			console.error('[JWT-验证] Token验证异常', {
				errorMessage: err.message,
				errorStack: err.stack,
				errorName: err.name,
				tokenPrefix: token?.substring(0, 20) + '...'
			});
			return null;
		}
	}
};

export default jwtUtils;
