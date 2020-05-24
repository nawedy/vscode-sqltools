import SQLiteLib from 'sqlite3';
import AbstractDriver from '@sqltools/base-driver';
import queries from './queries';
import sqltoolsRequire from '@sqltools/base-driver/dist/lib/require';
import * as mkdir from 'make-dir';
import { dirname } from 'path';
import { IConnectionDriver, NSDatabase, ContextValue } from '@sqltools/types';
import { parse as queryParse } from '@sqltools/util/query';
import generateId from '@sqltools/util/internal-id';
import keywordsCompletion from './keywords';

const SQLite3Version = '4.2.0';

export default class SQLite extends AbstractDriver<SQLiteLib.Database, any> implements IConnectionDriver {

  public readonly deps: typeof AbstractDriver.prototype['deps'] = [{
    type: AbstractDriver.CONSTANTS.DEPENDENCY_PACKAGE,
    name: 'sqlite3',
    version: SQLite3Version,
  }];


  queries = queries;

  private get lib() {
    return sqltoolsRequire('sqlite3') as SQLiteLib.sqlite3;
  }

  createFileIfNotExists = () => {
    if (this.credentials.database.toLowerCase() === ':memory:') return;

    const baseDir = dirname(this.credentials.database);
    mkdir.sync(baseDir);
  }

  public async open() {
    if (this.connection) {
      return this.connection;
    }

    this.needToInstallDependencies();
    this.createFileIfNotExists();
    const db = await new Promise<SQLiteLib.Database>((resolve, reject) => {
      const instance = new (this.lib).Database(this.credentials.database, (err) => {
        if (err) return reject(err);
        return resolve(instance);
      });
    });

    this.connection = Promise.resolve(db);
    return this.connection;
  }

  public async close() {
    if (!this.connection) return Promise.resolve();
    const db = await this.connection
    await new Promise((resolve, reject) => {
      db.close(err => err ? reject(err) : resolve());
    });
    this.connection = null;
  }

  private runSingleQuery(db: SQLiteLib.Database, query: string) {
    return new Promise<any[]>((resolve, reject) => {
      db.all(query,(err, rows) => {
        if (err) return reject(err);
        return resolve(rows);
      })
    });
  }

  public query: (typeof AbstractDriver)['prototype']['query'] = async (query, opt = {}) => {
    const db = await this.open();
    const { requestId } = opt;
    const queries = queryParse(query.toString()).filter(Boolean);
    return Promise.all(queries.map(async query => {
      const results: any[][] = (await this.runSingleQuery(db, query)) || [];
      const messages = [];
      if (results.length === 0 && query.toLowerCase() !== 'select') {
        messages.push(`${results.length} rows were affected.`);
      }
      return <NSDatabase.IResult>{
        requestId,
        resultId: generateId(),
        connId: this.getId(),
        cols: results && results.length ? Object.keys(results[0]) : [],
        messages,
        query,
        results,
      };
    }));
  }

  public async testConnection() {
    await this.open()
    await this.query('SELECT 1', {});
  }

  public async getColumns(): Promise<NSDatabase.IColumn[]> {
    const allTables = await this.getTables();
    const columns: NSDatabase.IColumn[] = [];

    await Promise.all(allTables.map(async t => {
      const [[{ results: tableColumns }], [{ results: fks }]] = await Promise.all([
        this.query(replacer(this.queries.fetchColumns, { table: t.name })),
        this.query(replacer(this.queries.listFks as string, { table: t.name })),
      ]);

      const fksMap = fks.reduce((agg, fk) => ({ ...agg, [fk.from]: true }), {});

      tableColumns.forEach(obj => columns.push({
          columnName: obj.name,
          defaultValue: obj.dftl_value || undefined,
          isNullable: obj.notnull ? obj.notnull.toString() === '1' : null,
          tableCatalog: obj.tablecatalog,
          tableDatabase: this.credentials.database,
          tableName: t.name,
          type: obj.type,
          size: null,
          isPk: Boolean(obj.pk),
          isFk: !!fksMap[obj.name],
          tree: obj.tree,
      }));
      return Promise.resolve();
    }));

  public searchItems(itemType: ContextValue, search: string, extraParams: any = {}): Promise<NSDatabase.SearchableItem[]> {
    switch (itemType) {
      case ContextValue.TABLE:
        return this.queryResults(this.queries.searchTables({ search }));
      case ContextValue.COLUMN:
        return this.queryResults(this.queries.searchColumns({ search, ...extraParams }));
    }
  }
  public getStaticCompletions = async () => {
    return keywordsCompletion;
  }
}