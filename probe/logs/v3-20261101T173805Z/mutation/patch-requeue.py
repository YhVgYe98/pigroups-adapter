import sys, pathlib
d = pathlib.Path(sys.argv[1])
p = d / 'src/loop.ts'
s = p.read_text()
old = "        if (event.aborted === true) this.requeueLastDelivered();"
new = "        if (event.aborted === true) { /* MUTATION: the batch is not put back */ }"
assert s.count(old) == 1
p.write_text(s.replace(old, new))
