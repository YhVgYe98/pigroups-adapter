import sys, pathlib
d = pathlib.Path(sys.argv[1])
p = d / 'src/loop.ts'
s = p.read_text()
old = "    for (const wake of due) this.enqueue({ text: `[scheduled] ${wake.note}`, kind: 'scheduled' });"
new = "    for (const wake of due) this.enqueue({ text: `[scheduled] ${wake.note}`, kind: 'scheduled', windowless: true }); // MUTATION: a wake bypasses the window"
assert s.count(old) == 1
p.write_text(s.replace(old, new))
