// Probe: a local listener hands text to the mod, the mod submits it, and the outcome goes to a file per id.
const SOCK = '/run/user/1000/p158/mod.sock'
const ROOT = '__ROOT__'
export function register(on) {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const done = (id) => (r) => $.fs.write(ROOT + '/acks/' + id + '.result.json', JSON.stringify({ at: Date.now(), r }))
    const fail = (id) => (err) => $.fs.write(ROOT + '/acks/' + id + '.result.json', JSON.stringify({ at: Date.now(), err: String(err) }))
    const handle = (m) => {
      const call = m.kind === 'command'
        ? $.command.run({ command: m.command, args: m.args })
        : $.prompt.submit(m.asUser === false ? { text: m.text } : { text: m.text, asUser: true })
      call.then(done(m.id), fail(m.id))
    }
    void (async () => {
      let buf = ''
      const child = $.process.spawn({ argv: ['python3', '-I', ROOT + '/mod-inbox/hooks/inbox_listener.py', SOCK] })
      for await (const { stream, text } of child) {
        if (stream !== 'stdout') { $.ui.log(text, { to: 'debug' }); continue }
        buf += text
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          handle(JSON.parse(line))
        }
      }
    })().catch((x) => $.ui.log(String(x), { to: 'debug' }))
    return started
  })
}
