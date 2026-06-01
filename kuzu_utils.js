import kuzu from 'kuzu';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DEFAULT_KUZU_DIR = path.join(os.homedir(), '.agentlag', 'kuzu_db');

export class KuzuClient {
    constructor(dbPath = DEFAULT_KUZU_DIR) {
        this.dbPath = dbPath;
        this.db = null;
        this.conn = null;
        this._initialized = false;
    }

    async init() {
        if (this._initialized) return;

        const parentDir = path.dirname(this.dbPath);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }

        this.db = new kuzu.Database(this.dbPath);
        this.conn = new kuzu.Connection(this.db);

        await this._ensureSchema();
        this._initialized = true;
    }

    async _ensureSchema() {
        try {
            await this.conn.query('MATCH (e:Entidad) RETURN e LIMIT 1');
        } catch (e) {
            console.log("Initializing Kuzu schema...");
            try {
                await this.conn.query('CREATE NODE TABLE Entidad(nombre STRING, tipo STRING, PRIMARY KEY(nombre))');
                await this.conn.query('CREATE REL TABLE RELACIONA(FROM Entidad TO Entidad, descripcion STRING)');
            } catch (schemaError) {
                if (!schemaError.message.includes('already exists')) {
                    throw schemaError;
                }
            }
        }
    }

    async query(cypher) {
        await this.init();
        const result = await this.conn.query(cypher);
        const rows = [];
        while (result.hasNext()) {
            rows.push(await result.getNext());
        }
        return rows;
    }

    async execute(cypher) {
        await this.init();
        return await this.conn.query(cypher);
    }

    async close() {
        this.conn = null;
        this.db = null;
        this._initialized = false;
    }
}

export const kuzuClient = new KuzuClient();
