import s3Service from './s3-service';
import settingService from './setting-service';

const r2Service = {

	async hasOSS(c) {

		console.error('[R2] hasOSS 检查 OSS 配置...');
		
		console.error('[R2] 检查 Cloudflare R2 原生绑定...');
		console.error('[R2] c.env.r2 存在:', !!c.env.r2);
		
		if (c.env.r2) {
			console.error('[R2] 使用 Cloudflare 原生 R2，返回 true');
			return true;
		}

		console.error('[R2] 未使用原生 R2，检查 S3 兼容配置...');
		const setting = await settingService.query(c);
		const { bucket, region, endpoint, s3AccessKey, s3SecretKey } = setting;

		console.error('[R2] S3 兼容配置详情:', {
			bucket: bucket || '(未配置)',
			region: region || '(未配置)',
			endpoint: endpoint || '(未配置)',
			s3AccessKey: s3AccessKey ? `${s3AccessKey.substring(0, 10)}...` : '(未配置)',
			s3SecretKey: s3SecretKey ? '(已配置，长度: ' + s3SecretKey.length + ')' : '(未配置)',
			hasBucket: !!bucket,
			hasRegion: !!region,
			hasEndpoint: !!endpoint,
			hasAccessKey: !!s3AccessKey,
			hasSecretKey: !!s3SecretKey
		});

		const result = !!(bucket && region && endpoint && s3AccessKey && s3SecretKey);
		console.error('[R2] OSS 配置检查结果:', result);
		
		if (!result) {
			console.error('[R2] OSS 配置不完整，缺失的项:', {
				缺失bucket: !bucket,
				缺失region: !region,
				缺失endpoint: !endpoint,
				缺失s3AccessKey: !s3AccessKey,
				缺失s3SecretKey: !s3SecretKey
			});
		}

		return result;
	},

	async putObj(c, key, content, metadata) {

		console.error('[R2] ========== 开始上传对象 ==========');
		console.error('[R2] 上传参数:', { 
			key, 
			useNativeR2: !!c.env.r2,
			hasR2Env: !!c.env.r2,
			contentLength: content?.byteLength || content?.length || 0,
			metadataKeys: Object.keys(metadata),
			metadata
		});

		if (c.env.r2) {

			console.error('[R2] 使用 Cloudflare 原生 R2 API');

			try {
				console.error('[R2] 调用 c.env.r2.put(), key:', key);
				await c.env.r2.put(key, content, {
					httpMetadata: { ...metadata }
				});
				console.error('[R2] 原生 R2 上传成功:', key);
			} catch (error) {
				console.error('[R2] 原生 R2 上传失败:', {
					key,
					error: error.message,
					stack: error.stack
				});
				throw error;
			}

		} else {

			console.error('[R2] 使用 S3 兼容 API (MinIO/其他S3)');
			console.error('[R2] 准备调用 s3Service.putObj()');
			
			try {
				await s3Service.putObj(c, key, content, metadata);
				console.error('[R2] S3 上传成功:', key);
			} catch (error) {
				console.error('[R2] S3 上传失败:', {
					key,
					error: error.message,
					stack: error.stack
				});
				throw error;
			}

		}

		console.error('[R2] ========== 对象上传完成 ==========');

	},

	async getObj(c, key) {
		return await c.env.r2.get(key);
	},

	async delete(c, key) {

		const keys = typeof key === 'string' ? [key] : key;
		console.error('[R2] 开始删除对象', { 
			count: keys.length, 
			useNativeR2: !!c.env.r2 
		});

		if (c.env.r2) {

			console.error('[R2] 使用 Cloudflare 原生 R2 API 删除');

			try {
				await c.env.r2.delete(key);
				console.error('[R2] 原生 R2 删除成功');
			} catch (error) {
				console.error('[R2] 原生 R2 删除失败:', error.message);
				throw error;
			}

		} else {

			console.error('[R2] 使用 S3 兼容 API (MinIO) 删除');
			await s3Service.deleteObj(c, key);

		}

	}

};
export default r2Service;
