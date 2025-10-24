import orm from '../entity/orm';
import email from '../entity/email';
import settingService from './setting-service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(timezone);
import { eq } from 'drizzle-orm';
import jwtUtils from '../utils/jwt-utils';
import emailMsgTemplate from '../template/email-msg';
import emailTextTemplate from '../template/email-text';
import emailHtmlTemplate from '../template/email-html';
import verifyUtils from '../utils/verify-utils';

const telegramService = {

	async getEmailContent(c, params) {

		console.log('[TG-查看原文] 开始处理查看原文请求', { 
			token: params.token?.substring(0, 20) + '...', // 只打印前20个字符避免泄露
			hasToken: !!params.token 
		});

		const { token } = params

		try {
			const result = await jwtUtils.verifyToken(c, token);
			console.log('[TG-查看原文] JWT验证结果', { 
				isValid: !!result, 
				emailId: result?.emailId 
			});

			if (!result) {
				console.warn('[TG-查看原文] JWT验证失败，访问被拒绝');
				return emailTextTemplate('Access denied')
			}

			console.log('[TG-查看原文] 开始查询邮件数据', { emailId: result.emailId });
			const emailRow = await orm(c).select().from(email).where(eq(email.emailId, result.emailId)).get();
			
			console.log('[TG-查看原文] 邮件查询结果', { 
				found: !!emailRow,
				emailId: emailRow?.emailId,
				hasContent: !!emailRow?.content,
				hasText: !!emailRow?.text,
				contentLength: emailRow?.content?.length || 0,
				textLength: emailRow?.text?.length || 0
			});

			if (emailRow) {

				if (emailRow.content) {
					console.log('[TG-查看原文] 准备渲染HTML内容');
					const { r2Domain } = await settingService.query(c);
					console.log('[TG-查看原文] 获取R2域名', { r2Domain });
					const htmlResult = emailHtmlTemplate(emailRow.content || '', r2Domain);
					console.log('[TG-查看原文] HTML模板渲染成功', { 
						resultLength: htmlResult?.length 
					});
					return htmlResult;
				} else {
					console.log('[TG-查看原文] 使用纯文本模式渲染');
					const textResult = emailTextTemplate(emailRow.text || '');
					console.log('[TG-查看原文] 纯文本模板渲染成功', { 
						resultLength: textResult?.length 
					});
					return textResult;
				}

			} else {
				console.warn('[TG-查看原文] 邮件不存在', { emailId: result.emailId });
				return emailTextTemplate('The email does not exist')
			}

		} catch (error) {
			console.error('[TG-查看原文] 处理过程发生异常', {
				errorMessage: error.message,
				errorStack: error.stack,
				errorName: error.name,
				token: params.token?.substring(0, 20) + '...'
			});
			return emailTextTemplate('An error occurred while loading the email')
		}

	},

	async sendEmailToBot(c, email) {

		console.log('[TG-发送消息] 开始发送邮件到Telegram', {
			emailId: email.emailId,
			subject: email.subject,
			from: email.sendEmail,
			to: email.toEmail
		});

		try {
			const { tgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);

			console.log('[TG-发送消息] 获取配置信息', {
				hasTgBotToken: !!tgBotToken,
				tgBotTokenLength: tgBotToken?.length || 0,
				tgChatId,
				customDomain,
				tgMsgTo,
				tgMsgFrom,
				tgMsgText,
				isDomainValid: verifyUtils.isDomain(customDomain)
			});

			const tgChatIds = tgChatId.split(',');
			console.log('[TG-发送消息] 解析Chat IDs', { 
				chatIds: tgChatIds,
				count: tgChatIds.length 
			});

			console.log('[TG-发送消息] 开始生成JWT Token', { emailId: email.emailId });
			const jwtToken = await jwtUtils.generateToken(c, { emailId: email.emailId });
			console.log('[TG-发送消息] JWT Token生成成功', { 
				tokenLength: jwtToken?.length || 0,
				tokenPrefix: jwtToken?.substring(0, 20) + '...'
			});

			const webAppUrl = verifyUtils.isDomain(customDomain) ? `https://${customDomain}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404';
			console.log('[TG-发送消息] WebApp URL构建完成', { 
				webAppUrl: webAppUrl.substring(0, 80) + '...',
				isValid: webAppUrl.startsWith('https://')
			});

			const msgText = emailMsgTemplate(email, tgMsgTo, tgMsgFrom, tgMsgText);
			console.log('[TG-发送消息] 消息文本生成完成', { 
				textLength: msgText?.length || 0,
				textPreview: msgText?.substring(0, 200) + '...',
				fullText: msgText // 完整文本用于调试
			});

			await Promise.all(tgChatIds.map(async (chatId, index) => {
				try {
					console.log(`[TG-发送消息] 准备发送到Chat ${index + 1}/${tgChatIds.length}`, { 
						chatId: chatId.trim(),
						emailId: email.emailId 
					});

					const requestBody = {
						chat_id: chatId.trim(),
						parse_mode: 'HTML',
						text: msgText,
						reply_markup: {
							inline_keyboard: [
								[
									{
										text: '查看',
										web_app: { url: webAppUrl }
									}
								]
							]
						}
					};

					console.log(`[TG-发送消息] 请求体准备完成`, {
						chatId: chatId.trim(),
						hasReplyMarkup: !!requestBody.reply_markup,
						webAppUrlInRequest: requestBody.reply_markup.inline_keyboard[0][0].web_app.url.substring(0, 80) + '...'
					});

					const apiUrl = `https://api.telegram.org/bot${tgBotToken}/sendMessage`;
					console.log(`[TG-发送消息] 准备调用TG API`, {
						chatId: chatId.trim(),
						apiUrlPrefix: 'https://api.telegram.org/bot****/sendMessage'
					});

					const res = await fetch(apiUrl, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json'
						},
						body: JSON.stringify(requestBody)
					});

					console.log(`[TG-发送消息] TG API响应`, {
						chatId: chatId.trim(),
						status: res.status,
						statusText: res.statusText,
						ok: res.ok
					});

					if (!res.ok) {
						const errorText = await res.text();
						let errorJson = null;
						try {
							errorJson = JSON.parse(errorText);
						} catch (e) {
							// 无法解析为JSON，保持原文本
						}
						
						console.error(`[TG-发送消息] TG API返回错误`, {
							chatId: chatId.trim(),
							status: res.status,
							statusText: res.statusText,
							errorBody: errorText,
							errorJson: errorJson,
							errorDescription: errorJson?.description,
							errorCode: errorJson?.error_code,
							emailId: email.emailId,
							// 帮助调试：输出发送的消息文本
							sentMessagePreview: msgText.substring(0, 300),
							sentMessageLength: msgText.length
						});
					} else {
						const responseData = await res.json();
						console.log(`[TG-发送消息] 消息发送成功`, {
							chatId: chatId.trim(),
							messageId: responseData?.result?.message_id,
							emailId: email.emailId
						});
					}
				} catch (e) {
					console.error(`[TG-发送消息] 发送异常`, {
						chatId: chatId.trim(),
						emailId: email.emailId,
						errorMessage: e.message,
						errorStack: e.stack,
						errorName: e.name
					});
				}
			}));

			console.log('[TG-发送消息] 所有消息发送任务完成', { 
				emailId: email.emailId,
				chatCount: tgChatIds.length 
			});

		} catch (error) {
			console.error('[TG-发送消息] sendEmailToBot整体异常', {
				emailId: email.emailId,
				errorMessage: error.message,
				errorStack: error.stack,
				errorName: error.name
			});
			throw error; // 重新抛出错误以便上层捕获
		}

	}

}

export default telegramService
