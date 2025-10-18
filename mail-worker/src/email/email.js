import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, roleConst, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import roleService from '../service/role-service';
import verifyUtils from '../utils/verify-utils';
import r2Service from '../service/r2-service';
import userService from '../service/user-service';

dayjs.extend(utc);
dayjs.extend(timezone);

export async function email(message, env, ctx) {

	try {

		console.error('[RECEIVE-EMAIL] ========== 开始接收邮件 ==========');
		console.error('[RECEIVE-EMAIL] 收件人:', message.to);
		console.error('[RECEIVE-EMAIL] 发件人:', message.from);

		const {
			receive,
			tgBotToken,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient
		} = await settingService.query({ env });

		console.error('[RECEIVE-EMAIL] 系统设置:', {
			receive,
			r2Domain,
			hasR2Domain: !!r2Domain
		});

		if (receive === settingConst.receive.CLOSE) {
			console.error('[RECEIVE-EMAIL] 接收功能已关闭');
			message.setReject('Service suspended');
			return;
		}

		console.error('[RECEIVE-EMAIL] 开始读取邮件原始内容...');
		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		console.error('[RECEIVE-EMAIL] 邮件内容读取完成, 长度:', content.length);
		console.error('[RECEIVE-EMAIL] 开始解析邮件...');
		const email = await PostalMime.parse(content);
		console.error('[RECEIVE-EMAIL] 邮件解析完成:', {
			subject: email.subject,
			from: email.from.address,
			hasHtml: !!email.html,
			htmlLength: email.html?.length,
			attachmentsCount: email.attachments?.length
		});

		const account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			message.setReject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			 userRow = await userService.selectById({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {

			let { banEmail, banEmailType, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				message.setReject('Mailbox disabled');
				return;
			}

			banEmail = banEmail.split(',').filter(item => item !== '');


			if (banEmail.includes('*')) {

				if (!banEmailHandler(banEmailType, message, email)) return;

			}

			for (const item of banEmail) {

				if (verifyUtils.isDomain(item)) {

					const banDomain = item.toLowerCase();
					const receiveDomain = emailUtils.getDomain(email.from.address.toLowerCase());

					if (banDomain === receiveDomain) {

						if (!banEmailHandler(banEmailType, message, email)) return;

					}

				} else {

					if (item.toLowerCase() === email.from.address.toLowerCase()) {

						if (!banEmailHandler(banEmailType, message, email)) return;

					}

				}

			}

		}


		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';

		const params = {
			toEmail: message.to,
			toName: toName,
			sendEmail: email.from.address,
			name: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		console.error('[RECEIVE-EMAIL] 开始处理附件...');
		const attachments = [];
		const cidAttachments = [];

		console.error('[RECEIVE-EMAIL] 邮件原始附件数量:', email.attachments?.length || 0);

		for (let i = 0; i < email.attachments.length; i++) {
			const item = email.attachments[i];
			console.error(`[RECEIVE-EMAIL] 处理附件 [${i + 1}/${email.attachments.length}]`, {
				filename: item.filename,
				mimeType: item.mimeType,
				contentLength: item.content?.length || item.content?.byteLength || 0,
				hasContentId: !!item.contentId
			});

			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			
			console.error(`[RECEIVE-EMAIL] 附件 [${i + 1}] 生成 key:`, attachment.key);
			
			attachments.push(attachment);
			if (attachment.contentId) {
				console.error(`[RECEIVE-EMAIL] 附件 [${i + 1}] 是内嵌图片 (CID):`, attachment.contentId);
				cidAttachments.push(attachment);
			}
		}

		console.error('[RECEIVE-EMAIL] 附件处理完成:', {
			attachmentsCount: attachments.length,
			cidAttachmentsCount: cidAttachments.length
		});

		console.error('[RECEIVE-EMAIL] 保存邮件记录到数据库...');
		let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);
		console.error('[RECEIVE-EMAIL] 邮件记录已保存, emailId:', emailRow.emailId);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		console.error('[RECEIVE-EMAIL] 准备上传附件到存储...');
		console.error('[RECEIVE-EMAIL] 附件数量:', attachments.length);
		console.error('[RECEIVE-EMAIL] 检查是否有 OSS 配置...');
		const hasOSS = await r2Service.hasOSS({ env });
		console.error('[RECEIVE-EMAIL] OSS 可用:', hasOSS);

		try {
			if (attachments.length > 0 && hasOSS) {
				console.error('[RECEIVE-EMAIL] 开始上传附件到 R2/S3...');
				await attService.addAtt({ env }, attachments);
				console.error('[RECEIVE-EMAIL] 所有附件上传成功');
			} else {
				if (attachments.length === 0) {
					console.error('[RECEIVE-EMAIL] 没有附件需要上传');
				} else {
					console.error('[RECEIVE-EMAIL] OSS 未配置，跳过附件上传');
				}
			}
		} catch (e) {
			console.error('[RECEIVE-EMAIL] 附件上传失败:', {
				error: e.message,
				stack: e.stack
			});
		}

		console.error('[RECEIVE-EMAIL] 完成邮件接收流程...');
		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);
		console.error('[RECEIVE-EMAIL] 邮件状态已更新为:', account ? 'RECEIVE' : 'NOONE');


		if (ruleType === settingConst.ruleType.RULE) {

			const emails = ruleEmail.split(',');

			if (!emails.includes(message.to)) {
				return;
			}

		}


		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {

			const tgMessage = `<b>${params.subject}</b>

<b>发件人：</b>${params.name}		&lt;${params.sendEmail}&gt;
<b>收件人：\u200B</b>${message.to}
<b>时间：</b>${dayjs.utc(emailRow.createTime).tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm')}

${params.text || emailUtils.htmlToText(params.content) || ''}
`;

			const tgChatIds = tgChatId.split(',');

			await Promise.all(tgChatIds.map(async chatId => {
				try {
					const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							chat_id: chatId,
							parse_mode: 'HTML',
							text: tgMessage
						})
					});
					if (!res.ok) {
						console.error(`转发 Telegram 失败: chatId=${chatId}, 状态码=${res.status}`);
					}
				} catch (e) {
					console.error(`转发 Telegram 失败: chatId=${chatId}`, e);
				}
			}));
		}

		if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

			const emails = forwardEmail.split(',');

			await Promise.all(emails.map(async email => {

				try {
					await message.forward(email);
				} catch (e) {
					console.error(`转发邮箱 ${email} 失败：`, e);
				}

			}));

		}

	} catch (e) {

		console.error('[RECEIVE-EMAIL] ========== 邮件接收异常 ==========');
		console.error('[RECEIVE-EMAIL] 错误信息:', {
			message: e.message,
			stack: e.stack,
			name: e.name
		});
	}

	console.error('[RECEIVE-EMAIL] ========== 邮件接收流程结束 ==========');
}

function banEmailHandler(banEmailType, message, email) {

	if (banEmailType === roleConst.banEmailType.ALL) {
		message.setReject('Mailbox disabled');
		return false;
	}

	if (banEmailType === roleConst.banEmailType.CONTENT) {
		email.html = 'The content has been deleted';
		email.text = 'The content has been deleted';
		email.attachments = [];
	}

	return true;

}
