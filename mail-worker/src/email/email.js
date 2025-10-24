import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, roleConst, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import verifyUtils from '../utils/verify-utils';
import r2Service from '../service/r2-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';

export async function email(message, env, ctx) {

	console.log('========== [邮件接收] 开始处理新邮件 ==========');
	console.log('[邮件接收-入口] 收到新邮件', {
		to: message.to,
		from: message.from,
		headers: message.headers
	});

	try {

		console.log('[邮件接收-配置] 开始查询系统配置');
		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient
		} = await settingService.query({ env });

		console.log('[邮件接收-配置] 系统配置获取成功', {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient,
			tgBotStatusEnum: settingConst.tgBotStatus.OPEN,
			isTgEnabled: tgBotStatus === settingConst.tgBotStatus.OPEN,
			hasTgChatId: !!tgChatId
		});

		if (receive === settingConst.receive.CLOSE) {
			console.log('[邮件接收-拒绝] 服务已暂停');
			message.setReject('Service suspended');
			return;
		}


		console.log('[邮件接收-解析] 开始读取原始邮件内容');
		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		console.log('[邮件接收-解析] 原始邮件读取完成', { contentLength: content.length });

		console.log('[邮件接收-解析] 开始解析邮件');
		const email = await PostalMime.parse(content);
		console.log('[邮件接收-解析] 邮件解析成功', {
			from: email.from?.address,
			subject: email.subject,
			hasHtml: !!email.html,
			hasText: !!email.text,
			attachmentsCount: email.attachments?.length || 0
		});

		console.log('[邮件接收-账户] 开始查询收件账户', { to: message.to });
		const account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);
		console.log('[邮件接收-账户] 账户查询结果', { 
			found: !!account,
			accountId: account?.accountId,
			userId: account?.userId
		});

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			console.log('[邮件接收-拒绝] 收件人不存在且已关闭无收件人接收');
			message.setReject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			console.log('[邮件接收-用户] 查询用户信息', { userId: account.userId });
			userRow = await userService.selectById({ env: env }, account.userId);
			console.log('[邮件接收-用户] 用户信息获取', { 
				userEmail: userRow?.email,
				isAdmin: userRow?.email === env.admin 
			});
		}

		if (account && userRow.email !== env.admin) {

			console.log('[邮件接收-权限] 开始检查用户权限和黑名单');
			let { banEmail, banEmailType, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);
			console.log('[邮件接收-权限] 权限配置', { 
				banEmail, 
				banEmailType, 
				availDomain 
			});

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				console.log('[邮件接收-拒绝] 域名权限检查失败');
				message.setReject('Mailbox disabled');
				return;
			}

			banEmail = banEmail.split(',').filter(item => item !== '');
			console.log('[邮件接收-黑名单] 黑名单列表', { 
				banEmailList: banEmail,
				count: banEmail.length 
			});

			if (banEmail.includes('*')) {
				console.log('[邮件接收-黑名单] 发现全局黑名单(*)，执行处理');
				if (!banEmailHandler(banEmailType, message, email)) {
					console.log('[邮件接收-终止] 全局黑名单处理导致流程终止');
					return;
				}
			}

			for (const item of banEmail) {

				if (verifyUtils.isDomain(item)) {

					const banDomain = item.toLowerCase();
					const receiveDomain = emailUtils.getDomain(email.from.address.toLowerCase());

					if (banDomain === receiveDomain) {
						console.log('[邮件接收-黑名单] 匹配到黑名单域名', { 
							banDomain, 
							receiveDomain,
							from: email.from.address 
						});
						if (!banEmailHandler(banEmailType, message, email)) {
							console.log('[邮件接收-终止] 黑名单域名处理导致流程终止');
							return;
						}
					}

				} else {

					if (item.toLowerCase() === email.from.address.toLowerCase()) {
						console.log('[邮件接收-黑名单] 匹配到黑名单邮箱', { 
							banEmail: item, 
							from: email.from.address 
						});
						if (!banEmailHandler(banEmailType, message, email)) {
							console.log('[邮件接收-终止] 黑名单邮箱处理导致流程终止');
							return;
						}
					}

				}

			}

			console.log('[邮件接收-黑名单] 黑名单检查通过');

		}


		console.log('[邮件接收-保存] 开始准备邮件保存数据');

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

		console.log('[邮件接收-保存] 邮件参数准备完成', {
			toEmail: params.toEmail,
			sendEmail: params.sendEmail,
			subject: params.subject,
			hasContent: !!params.content,
			hasText: !!params.text,
			userId: params.userId,
			accountId: params.accountId
		});

		const attachments = [];
		const cidAttachments = [];

		console.log('[邮件接收-附件] 开始处理附件', { 
			attachmentsCount: email.attachments?.length || 0 
		});

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		console.log('[邮件接收-附件] 附件处理完成', {
			attachmentsCount: attachments.length,
			cidAttachmentsCount: cidAttachments.length
		});

		console.log('[邮件接收-保存] 调用emailService.receive保存邮件');
		let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);
		console.log('[邮件接收-保存] 邮件初步保存成功', {
			emailId: emailRow.emailId,
			status: emailRow.status
		});

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		try {
			if (attachments.length > 0 && await r2Service.hasOSS({ env })) {
				console.log('[邮件接收-附件上传] 开始上传附件到OSS', { 
					count: attachments.length 
				});
				await attService.addAtt({ env }, attachments);
				console.log('[邮件接收-附件上传] 附件上传成功');
			}
		} catch (e) {
			console.error('[邮件接收-附件上传] 附件上传失败', {
				errorMessage: e.message,
				errorStack: e.stack,
				errorName: e.name
			});
		}

		console.log('[邮件接收-完成] 完成邮件接收', { emailId: emailRow.emailId });
		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);
		console.log('[邮件接收-完成] 邮件状态更新完成', {
			emailId: emailRow.emailId,
			finalStatus: emailRow.status,
			subject: emailRow.subject
		});

		console.log('[邮件接收-规则] 开始检查转发规则', {
			ruleType,
			ruleEmail,
			messageTo: message.to,
			ruleTypeEnum: settingConst.ruleType.RULE
		});

		if (ruleType === settingConst.ruleType.RULE) {

			const emails = ruleEmail.split(',');
			console.log('[邮件接收-规则] 规则类型为RULE，检查邮箱白名单', {
				allowedEmails: emails,
				currentTo: message.to,
				isInWhitelist: emails.includes(message.to)
			});

			if (!emails.includes(message.to)) {
				console.log('[邮件接收-规则-跳过] 当前收件邮箱不在白名单中，终止转发流程');
				console.log('========== [邮件接收] 处理完成（被规则过滤） ==========');
				return;
			}

			console.log('[邮件接收-规则] 邮箱在白名单中，继续执行转发');

		} else {
			console.log('[邮件接收-规则] 规则类型非RULE，跳过白名单检查');
		}

	//转发到TG
	if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
		console.log('[邮件接收-TG转发] 准备转发邮件到Telegram', {
			tgBotStatus,
			tgChatId,
			emailId: emailRow.emailId,
			subject: emailRow.subject,
			hasContent: !!emailRow.content,
			hasText: !!emailRow.text
		});
		try {
			await telegramService.sendEmailToBot({ env }, emailRow);
			console.log('[邮件接收-TG转发] Telegram转发完成', { 
				emailId: emailRow.emailId 
			});
		} catch (e) {
			console.error('[邮件接收-TG转发] Telegram转发失败', {
				emailId: emailRow.emailId,
				errorMessage: e.message,
				errorStack: e.stack,
				errorName: e.name
			});
		}
	} else {
		console.log('[邮件接收-TG转发] 跳过TG转发', {
			tgBotStatus,
			hasTgChatId: !!tgChatId,
			reason: tgBotStatus !== settingConst.tgBotStatus.OPEN ? 'TG Bot未开启' : '未配置Chat ID'
		});
	}

		//转发到其他邮箱
		if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

			const emails = forwardEmail.split(',');
			console.log('[邮件接收-邮箱转发] 开始转发到其他邮箱', {
				forwardEmails: emails,
				count: emails.length
			});

			await Promise.all(emails.map(async email => {

				try {
					console.log('[邮件接收-邮箱转发] 转发到', { email });
					await message.forward(email);
					console.log('[邮件接收-邮箱转发] 转发成功', { email });
				} catch (e) {
					console.error(`[邮件接收-邮箱转发] 转发邮箱 ${email} 失败`, {
						email,
						errorMessage: e.message,
						errorStack: e.stack
					});
				}

			}));

			console.log('[邮件接收-邮箱转发] 所有邮箱转发任务完成');

		} else {
			console.log('[邮件接收-邮箱转发] 跳过邮箱转发', {
				forwardStatus,
				hasForwardEmail: !!forwardEmail,
				reason: forwardStatus !== settingConst.forwardStatus.OPEN ? '邮箱转发未开启' : '未配置转发邮箱'
			});
		}

		console.log('========== [邮件接收] 处理完成（全部成功） ==========');

	} catch (e) {

		console.error('========== [邮件接收] 处理异常 ==========');
		console.error('[邮件接收-异常] 邮件接收过程发生异常', {
			errorMessage: e.message,
			errorStack: e.stack,
			errorName: e.name,
			to: message?.to,
			from: message?.from
		});
	}
}

function banEmailHandler(banEmailType, message, email) {

	console.log('[邮件接收-黑名单处理] 执行黑名单处理', {
		banEmailType,
		from: email.from?.address,
		banEmailTypeAll: roleConst.banEmailType.ALL,
		banEmailTypeContent: roleConst.banEmailType.CONTENT
	});

	if (banEmailType === roleConst.banEmailType.ALL) {
		console.log('[邮件接收-黑名单处理] 拒绝接收（类型：ALL）');
		message.setReject('Mailbox disabled');
		return false;
	}

	if (banEmailType === roleConst.banEmailType.CONTENT) {
		console.log('[邮件接收-黑名单处理] 删除内容（类型：CONTENT）', {
			originalHtmlLength: email.html?.length || 0,
			originalTextLength: email.text?.length || 0,
			originalAttachmentsCount: email.attachments?.length || 0
		});
		email.html = 'The content has been deleted';
		email.text = 'The content has been deleted';
		email.attachments = [];
		console.log('[邮件接收-黑名单处理] 内容已删除，继续接收');
	}

	return true;

}
