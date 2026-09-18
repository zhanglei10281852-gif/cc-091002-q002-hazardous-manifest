export class ManifestStore {
  #items=new Map();
  create(manifest){this.#items.set(manifest.id,structuredClone(manifest));}
  get(id){const value=this.#items.get(id);return value&&structuredClone(value);}
  save(manifest){this.#items.set(manifest.id,structuredClone(manifest));}
  list(){return [...this.#items.values()].map(value=>structuredClone(value));}
  // 快照/恢复：服务重启后保管链事件与签名完整保留，可继续验证
  snapshot(){return JSON.stringify([...this.#items.values()]);}
  static restore(snapshot){
    const store=new ManifestStore();
    for(const manifest of JSON.parse(snapshot)) store.create(manifest);
    return store;
  }
}
