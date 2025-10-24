import emailUtils from '../utils/email-utils';

export default function emailMsgTemplate(email, tgMsgTo, tgMsgFrom, tgMsgText) {

	console.log('[邮件消息模板] 开始生成TG消息模板', {
		subject: email.subject,
		subjectLength: email.subject?.length || 0,
		tgMsgTo,
		tgMsgFrom,
		tgMsgText,
		emailName: email.name,
		emailNameLength: email.name?.length || 0,
		sendEmail: email.sendEmail,
		toEmail: email.toEmail,
		hasText: !!email.text,
		hasContent: !!email.content,
		textLength: email.text?.length || 0,
		contentLength: email.content?.length || 0
	});

	let template = `<b>${email.subject}</b>`

	console.log('[邮件消息模板] 主题部分生成', {
		templateSoFar: template,
		templateLength: template.length
	});

	if (tgMsgFrom === 'only-name') {
		template += `

发件人：${email.name}`
		console.log('[邮件消息模板] 添加发件人（仅姓名）', {
			name: email.name,
			templateLength: template.length
		});
	}

	if (tgMsgFrom === 'show') {
		template += `

发件人：${email.name}  &lt;${email.sendEmail}&gt;`
		console.log('[邮件消息模板] 添加发件人（完整）', {
			name: email.name,
			sendEmail: email.sendEmail,
			templateLength: template.length
		});
	}

	if(tgMsgTo === 'show' && tgMsgFrom === 'hide') {
		template += `

收件人：\u200B${email.toEmail}`
		console.log('[邮件消息模板] 添加收件人（tgMsgFrom=hide）', {
			toEmail: email.toEmail,
			templateLength: template.length
		});
	} else if(tgMsgTo === 'show') {
		template += `
收件人：\u200B${email.toEmail}`
		console.log('[邮件消息模板] 添加收件人（tgMsgTo=show）', {
			toEmail: email.toEmail,
			templateLength: template.length
		});
	}

	if(tgMsgText === 'show') {
		const emailText = email.text || emailUtils.htmlToText(email.content);
		
		console.log('[邮件消息模板] 准备添加邮件正文', {
			useEmailText: !!email.text,
			useConvertedHtml: !email.text && !!email.content,
			emailTextLength: emailText?.length || 0,
			emailTextPreview: emailText?.substring(0, 200),
			// 检查是否包含可能导致问题的字符
			containsLessThan: emailText?.includes('<'),
			containsGreaterThan: emailText?.includes('>'),
			containsAmpersand: emailText?.includes('&'),
			// 查找URL模式
			hasHttpUrl: /https?:\/\//.test(emailText || ''),
			// 查找可能被误认为标签的模式
			possibleTagPattern: /<[^>]*>/.test(emailText || '')
		});
		
		template += `

${emailText}`

		console.log('[邮件消息模板] 邮件正文添加完成', {
			finalTemplateLength: template.length,
			addedTextLength: emailText?.length || 0
		});
	}

	console.log('[邮件消息模板] 模板生成完成', {
		finalTemplateLength: template.length,
		templatePreview: template.substring(0, 300) + '...',
		fullTemplate: template // 完整模板用于调试
	});

	return template;

}
