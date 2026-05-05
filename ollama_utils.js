import http from 'http';
import https from 'https';

export function fetchOllamaModels(baseUrl = 'http://localhost:11434') {
    return new Promise((resolve) => {
        const url = new URL('/api/tags', baseUrl);
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const models = (json.models || []).map(m => m.name);
                    resolve(models);
                } catch {
                    resolve([]);
                }
            });
        });
        req.on('error', () => {
            resolve([]);
        });
        req.setTimeout(2000, () => {
            req.destroy();
            resolve([]);
        });
    });
}

export function fetchTogetherModels(apiKey) {
    return new Promise((resolve) => {
        if (!apiKey) { resolve([]); return; }
        const options = {
            hostname: 'api.together.xyz',
            path: '/v1/models',
            headers: { 'Authorization': `Bearer ${apiKey}` },
        };
        const req = https.get(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const models = (json || [])
                        .filter(m => m.type === 'chat' || m.type === 'language')
                        .map(m => m.id)
                        .sort();
                    resolve(models);
                } catch {
                    resolve([]);
                }
            });
        });
        req.on('error', () => resolve([]));
        req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    });
}

export function isOllamaRunning(baseUrl = 'http://localhost:11434') {
    return new Promise((resolve) => {
        const req = http.get(baseUrl, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
}
