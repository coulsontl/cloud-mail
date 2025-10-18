import orm from '../entity/orm';
import { att } from '../entity/att';
import { and, eq, isNull, inArray } from 'drizzle-orm';
import r2Service from './r2-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { attConst } from '../const/entity-const';
import { parseHTML } from 'linkedom';
import domainUtils from '../utils/domain-uitls';
import BizError from '../error/biz-error';

const attService = {

	async addAtt(c, attachments) {

		console.error('[ATT-SERVICE] addAtt 开始上传接收邮件的附件');
		console.error('[ATT-SERVICE] 附件数量:', attachments.length);

		for (let i = 0; i < attachments.length; i++) {
			const attachment = attachments[i];

			console.error(`[ATT-SERVICE] 上传附件 [${i + 1}/${attachments.length}]`, {
				key: attachment.key,
				filename: attachment.filename,
				mimeType: attachment.mimeType,
				size: attachment.size,
				hasContentId: !!attachment.contentId
			});

			let metadate = {
				contentType: attachment.mimeType,
			}

			if (!attachment.contentId) {
				metadate.contentDisposition = `attachment;filename=${attachment.filename}`
				console.error(`[ATT-SERVICE] 附件 [${i + 1}] 类型: 普通附件`);
			} else {
				metadate.contentDisposition = `inline;filename=${attachment.filename}`
				metadate.cacheControl = `max-age=259200`
				console.error(`[ATT-SERVICE] 附件 [${i + 1}] 类型: 内嵌图片 (CID)`);
			}

			console.error(`[ATT-SERVICE] 开始上传附件 [${i + 1}] 到 R2/S3...`);
			try {
				await r2Service.putObj(c, attachment.key, attachment.content, metadate);
				console.error(`[ATT-SERVICE] 附件 [${i + 1}] 上传成功`);
			} catch (error) {
				console.error(`[ATT-SERVICE] 附件 [${i + 1}] 上传失败:`, {
					key: attachment.key,
					error: error.message,
					stack: error.stack
				});
				throw error;
			}

		}

		console.error('[ATT-SERVICE] 所有附件上传完成，开始插入数据库...');
		await orm(c).insert(att).values(attachments).run();
		console.error('[ATT-SERVICE] 附件数据库记录插入完成');
	},

	list(c, params, userId) {
		const { emailId } = params;

		return orm(c).select().from(att).where(
			and(
				eq(att.emailId, emailId),
				eq(att.userId, userId),
				eq(att.type, attConst.type.ATT),
				isNull(att.contentId)
			)
		).all();
	},

	async toImageUrlHtml(c, content, r2Domain) {

		console.error('[ATT-SERVICE] toImageUrlHtml 开始处理内容');
		console.error('[ATT-SERVICE] 参数:', {
			hasContent: !!content,
			contentLength: content?.length,
			r2Domain
		});

		const { document } = parseHTML(content);

		const images = Array.from(document.querySelectorAll('img'));
		console.error('[ATT-SERVICE] 找到图片数量:', images.length);

		const attDataList = [];

		for (let i = 0; i < images.length; i++) {
			const img = images[i];
			const src = img.getAttribute('src');
			
			console.error(`[ATT-SERVICE] 处理图片 [${i + 1}/${images.length}]`, {
				srcPrefix: src?.substring(0, 50),
				isBase64: src?.startsWith('data:image')
			});

			if (src && src.startsWith('data:image')) {
				console.error(`[ATT-SERVICE] 图片 [${i + 1}] 是 base64 格式，开始转换...`);
				
				const file = fileUtils.base64ToFile(src);
				console.error(`[ATT-SERVICE] 图片 [${i + 1}] 文件信息:`, {
					name: file.name,
					type: file.type,
					size: file.size
				});

				const buff = await file.arrayBuffer();
				const key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(buff) + fileUtils.getExtFileName(file.name);
				
				console.error(`[ATT-SERVICE] 图片 [${i + 1}] 生成 key:`, key);
				
				img.setAttribute('src', domainUtils.toOssDomain(r2Domain) + '/' + key);

				const attData = {};
				attData.key = key;
				attData.filename = file.name;
				attData.mimeType = file.type;
				attData.size = file.size;
				attData.buff = buff;

				attDataList.push(attData);
				console.error(`[ATT-SERVICE] 图片 [${i + 1}] 已添加到 attDataList`);
			}

			const hasInlineWidth = img.hasAttribute('width');
			const style = img.getAttribute('style') || '';
			const hasStyleWidth = /(^|\s)width\s*:\s*[^;]+/.test(style);

			if (!hasInlineWidth && !hasStyleWidth) {
				const newStyle = (style ? style.trim().replace(/;$/, '') + '; ' : '') + 'max-width: 100%;';
				img.setAttribute('style', newStyle);
			}
		}

		console.error('[ATT-SERVICE] toImageUrlHtml 处理完成:', {
			attDataListLength: attDataList.length,
			htmlLength: document.toString().length
		});

		return { attDataList, html: document.toString() };
	},

	async saveSendAtt(c, attList, userId, accountId, emailId) {

		const attDataList = [];

		for (let att of attList) {
			att.buff = fileUtils.base64ToUint8Array(att.content);
			att.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(att.buff) + fileUtils.getExtFileName(att.filename);
			const attData = { userId, accountId, emailId };
			attData.key = att.key;
			attData.size = att.buff.length;
			attData.filename = att.filename;
			attData.mimeType = att.type;
			attData.type = attConst.type.ATT;
			attDataList.push(attData);
		}

		await orm(c).insert(att).values(attDataList).run();

		for (let att of attList) {
			await r2Service.putObj(c, att.key, att.buff, {
				contentType: att.type,
				contentDisposition: `attachment;filename=${att.filename}`
			});
		}

	},

	async saveArticleAtt(c, attDataList, userId, accountId, emailId) {

		console.error('[ATT-SERVICE] saveArticleAtt 开始保存文章附件');
		console.error('[ATT-SERVICE] 参数:', {
			attDataListLength: attDataList.length,
			userId,
			accountId,
			emailId
		});

		for (let i = 0; i < attDataList.length; i++) {
			const attData = attDataList[i];
			
			console.error(`[ATT-SERVICE] 保存附件 [${i + 1}/${attDataList.length}]`, {
				key: attData.key,
				filename: attData.filename,
				mimeType: attData.mimeType,
				size: attData.size
			});

			attData.userId = userId;
			attData.emailId = emailId;
			attData.accountId = accountId;
			attData.type = attConst.type.EMBED;

			console.error(`[ATT-SERVICE] 开始上传到 R2/S3, key: ${attData.key}`);
			
			try {
				await r2Service.putObj(c, attData.key, attData.buff, {
					contentType: attData.mimeType,
					cacheControl: `max-age=259200`,
					contentDisposition: `inline;filename=${attData.filename}`
				});
				console.error(`[ATT-SERVICE] 附件 [${i + 1}] 上传成功: ${attData.key}`);
			} catch (error) {
				console.error(`[ATT-SERVICE] 附件 [${i + 1}] 上传失败:`, {
					key: attData.key,
					error: error.message,
					stack: error.stack
				});
				throw error;
			}
		}

		console.error('[ATT-SERVICE] 所有附件上传完成，开始插入数据库记录');
		await orm(c).insert(att).values(attDataList).run();
		console.error('[ATT-SERVICE] 数据库记录插入完成');

	},

	async removeByUserIds(c, userIds) {
		await this.removeAttByField(c, 'user_id', userIds);
	},

	async removeByEmailIds(c, emailIds) {
		await this.removeAttByField(c, 'email_id', emailIds);
	},

	selectByEmailIds(c, emailIds) {
		return orm(c).select().from(att).where(
			and(
				inArray(att.emailId, emailIds),
				eq(att.type, attConst.type.ATT)
			))
			.all();
	},

	async removeAttByField(c, fieldName, fieldValues) {

		const sqlList = [];

		fieldValues.forEach(value => {

			sqlList.push(

				c.env.db.prepare(
					`SELECT a.key, a.att_id
						FROM attachments a
							   JOIN (SELECT key
									 FROM attachments
									 GROUP BY key
									 HAVING COUNT (*) = 1) t
									ON a.key = t.key
						WHERE a.${fieldName} = ?;`
					).bind(value)
			)

			sqlList.push(c.env.db.prepare(`DELETE FROM attachments WHERE ${fieldName} = ?`).bind(value))

		});

		const attListResult = await c.env.db.batch(sqlList);

		const delKeyList = attListResult.flatMap(r => r.results ? r.results.map(row => row.key) : []);

		if (delKeyList.length > 0) {
			await this.batchDelete(c, delKeyList);
		}

	},

	async batchDelete(c, keys) {
		if (!keys.length) return;

		const BATCH_SIZE = 1000;

		for (let i = 0; i < keys.length; i += BATCH_SIZE) {
			const batch = keys.slice(i, i + BATCH_SIZE);
			await r2Service.delete(c, batch);
		}

	},

	async removeByAccountId(c, accountId) {
		console.log(accountId)
		await this.removeAttByField(c, "account_id", [accountId])
	}
};

export default attService;
