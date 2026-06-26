import http from 'http';

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


export function isOllamaRunning(baseUrl = 'http://localhost:11434') {
    return new Promise((resolve) => {
        const req = http.get(baseUrl, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
}
