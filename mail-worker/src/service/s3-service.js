import { S3Client, PutObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import settingService from './setting-service';
import domainUtils from '../utils/domain-uitls';
const s3Service = {

	async putObj(c, key, content, metadata) {

		console.error('[S3] ========== S3 Service 开始上传对象 ==========');
		console.error('[S3] 上传参数:', { 
			key, 
			contentLength: content?.byteLength || content?.length || 0,
			metadataKeys: Object.keys(metadata),
			metadata
		});

		console.error('[S3] 开始创建 S3 客户端...');
		const client = await this.client(c);
		console.error('[S3] S3 客户端创建完成');

		const { bucket } = await settingService.query(c);

		console.error('[S3] 使用桶名称:', bucket);

		let obj = { Bucket: bucket, Key: key, Body: content,
			CacheControl: metadata.cacheControl
		}

		if (metadata.cacheControl) {
			obj.CacheControl = metadata.cacheControl
		}

		if (metadata.contentDisposition) {
			obj.ContentDisposition = metadata.contentDisposition
		}

		if (metadata.contentType) {
			obj.ContentType = metadata.contentType
		}

		console.error('[S3] PutObjectCommand 参数:', {
			Bucket: obj.Bucket,
			Key: obj.Key,
			ContentType: obj.ContentType,
			ContentDisposition: obj.ContentDisposition,
			CacheControl: obj.CacheControl,
			BodySize: obj.Body?.byteLength || obj.Body?.length || 0
		});

		try {
			console.error('[S3] 开始发送 PutObjectCommand 到 S3...');
			const result = await client.send(new PutObjectCommand(obj));
			console.error('[S3] S3 响应:', {
				statusCode: result.$metadata?.httpStatusCode,
				requestId: result.$metadata?.requestId,
				etag: result.ETag
			});
			console.error('[S3] ========== 上传成功 ==========', key);
		} catch (error) {
			console.error('[S3] ========== 上传失败 ==========', {
				key,
				errorName: error.name,
				errorMessage: error.message,
				errorCode: error.Code,
				statusCode: error.$metadata?.httpStatusCode,
				requestId: error.$metadata?.requestId,
				stack: error.stack
			});
			throw error;
		}
	},

	async deleteObj(c, keys) {

		if (typeof keys === 'string') {
			keys = [keys];
		}

		if (keys.length === 0) {
			return;
		}

		console.error('[S3] 开始删除对象', { count: keys.length, keys: keys.slice(0, 5) });

		const client = await this.client(c);
		const { bucket } = await settingService.query(c);

		console.error('[S3] 删除操作使用桶名称:', bucket);


		client.middlewareStack.add(
			(next) => async (args) => {

				const body = args.request.body

				// 计算 MD5 校验和并转换为 Base64 编码
				const encoder = new TextEncoder();
				const data = encoder.encode(body);

				// 使用 Web Crypto API 计算 MD5 校验和
				const hashBuffer = await crypto.subtle.digest('MD5', data);
				const hashArray = new Uint8Array(hashBuffer);
				const contentMD5 = btoa(String.fromCharCode.apply(null, hashArray));

				args.request.headers["Content-MD5"] = contentMD5;

				return next(args);
			},
			{ step: "build", name: "inspectRequestMiddleware" }
		);


		try {
			await client.send(
				new DeleteObjectsCommand({
					Bucket: bucket,
					Delete: {
						Objects: keys.map(key => ({ Key: key }))
					}
				})
			);
			console.error('[S3] 删除成功:', keys.length, '个对象');
		} catch (error) {
			console.error('[S3] 删除失败:', {
				count: keys.length,
				error: error.message,
				code: error.Code,
				statusCode: error.$metadata?.httpStatusCode
			});
			throw error;
		}
	},


	async client(c) {
		const { region, endpoint, s3AccessKey, s3SecretKey } = await settingService.query(c);
		
		console.error('[S3] 创建 S3 客户端配置:', {
			region: region || 'us-east-1',
			endpoint: endpoint,
			forcePathStyle: true,
			hasAccessKey: !!s3AccessKey,
			hasSecretKey: !!s3SecretKey
		});
		
		// MinIO 需要确保使用路径样式并正确配置端点
		const client = new S3Client({
			region: region || 'us-east-1',  // MinIO 建议使用 us-east-1
			endpoint: endpoint,
			forcePathStyle: true,  // 强制路径样式，避免桶名称作为子域名
			credentials: {
				accessKeyId: s3AccessKey,
				secretAccessKey: s3SecretKey,
			}
		});
		
		// 添加请求拦截器来记录实际发送的请求
		client.middlewareStack.add(
			(next) => async (args) => {
				console.error('[S3] 实际请求信息:', {
					hostname: args.request.hostname,
					path: args.request.path,
					method: args.request.method,
					protocol: args.request.protocol,
					headers: {
						host: args.request.headers['host'],
						'content-type': args.request.headers['content-type']
					}
				});
				
				const result = await next(args);
				
				console.error('[S3] 请求响应状态:', result.response?.statusCode);
				
				return result;
			},
			{ 
				step: "build", 
				name: "logRequestMiddleware",
				priority: "high"  // 确保这个中间件最先执行
			}
		);
		
		return client;
	}
}

export default s3Service
