import sys, pathlib
d = pathlib.Path(sys.argv[1])
p = d / 'src/surface.ts'
s = p.read_text()
old = """    pi.on('message_end', (event) => {
      const text = assistantTextOf(event.message);
      if (text !== undefined) this.lastAssistant = text;
    });"""
new = "    // MUTATION: message_end is not subscribed"
assert s.count(old) == 1
p.write_text(s.replace(old, new))
