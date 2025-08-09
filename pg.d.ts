declare module 'pg' {
  export class Pool {
    constructor(config?: any)
    query: any
    connect: any
    end: any
  }
}
