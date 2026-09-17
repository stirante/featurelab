// A minimal stand-in for jsonc.ParseAnnotations, for tests that need to go from file text back
// to the annotations the graph builder would report.
//
// It is NOT a second implementation of that parser and must not grow into one: it handles the
// one shape this editor writes -- a `// @featurelab:<name> <args>` line directly above a type
// key, with following comment lines as the body. The real parser handles block comments,
// attachment rules and byte spans, and is tested in Go.
export function ParseAnnotationsShim(contents: string): {
  name: string
  args: string[]
  text: string
  jsonPath: string
  line: number
  offset: number
  endOffset: number
}[] {
  const lines = contents.split('\n')
  const out: ReturnType<typeof ParseAnnotationsShim> = []
  for (let i = 0; i < lines.length; i++) {
    const directive = /^\s*\/\/\s*@featurelab:([A-Za-z0-9_.-]+)\s*(.*)$/.exec(lines[i] ?? '')
    if (directive === null) continue
    const body: string[] = []
    let j = i + 1
    for (; j < lines.length; j++) {
      const comment = /^\s*\/\/\s?(.*)$/.exec(lines[j] ?? '')
      if (comment === null || /@featurelab:/.test(lines[j] ?? '')) break
      body.push(comment[1] ?? '')
    }
    // The member the directive attaches to is the first non-comment line after it.
    const key = /^\s*"([^"]+)"\s*:/.exec(lines[j] ?? '')
    out.push({
      name: directive[1] ?? '',
      args: (directive[2] ?? '').split(/\s+/).filter((a) => a !== ''),
      text: body.join('\n'),
      jsonPath: key ? `$.${key[1]}` : '$',
      line: i + 1,
      offset: 0,
      endOffset: 0,
    })
  }
  return out
}
