import app from '../hono/hono';
import telegramService from '../service/telegram-service';

app.get('/telegram/getEmail/:token', async (c) => {
	const params = c.req.param();
	console.log('[TG-API] 收到查看原文请求', {
		path: c.req.path,
		method: c.req.method,
		hasToken: !!params.token,
		tokenLength: params.token?.length || 0,
		userAgent: c.req.header('user-agent'),
		referer: c.req.header('referer')
	});

	try {
		const content = await telegramService.getEmailContent(c, params);
		console.log('[TG-API] 内容获取成功，准备返回', {
			contentLength: content?.length || 0,
			contentType: 'text/html'
		});
		c.header('Cache-Control', 'public, max-age=604800, immutable');
		return c.html(content);
	} catch (error) {
		console.error('[TG-API] 处理请求时发生异常', {
			errorMessage: error.message,
			errorStack: error.stack,
			errorName: error.name,
			path: c.req.path,
			tokenPrefix: params.token?.substring(0, 20) + '...'
		});
		// 返回错误页面
		return c.html(`
			<!DOCTYPE html>
			<html>
			<head><title>Error</title></head>
			<body><h1>An error occurred</h1><p>${error.message}</p></body>
			</html>
		`, 500);
	}
});

