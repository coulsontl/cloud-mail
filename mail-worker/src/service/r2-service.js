import s3Service from './s3-service';
import settingService from './setting-service';

const r2Service = {

	async hasOSS(c) {

		if (c.env.r2) {
			return true;
		}

		const setting = await settingService.query(c);
		const { bucket, region, endpoint, s3AccessKey, s3SecretKey } = setting;

		return !!(bucket && region && endpoint && s3AccessKey && s3SecretKey);
	},

	async putObj(c, key, content, metadata) {

		console.error('[R2] 开始上传对象', { 
			key, 
			useNativeR2: !!c.env.r2,
			metadataKeys: Object.keys(metadata) 
		});

		if (c.env.r2) {

			console.error('[R2] 使用 Cloudflare 原生 R2 API');

			try {
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

			console.error('[R2] 使用 S3 兼容 API (MinIO)');
			await s3Service.putObj(c, key, content, metadata);

		}

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
