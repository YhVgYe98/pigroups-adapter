import sys, pathlib
d = pathlib.Path(sys.argv[1])
p = d / 'src/loop.ts'
s = p.read_text()
old = "    return this.windowStart !== null && now - this.windowStart >= this.config.deliveryWindowMs;"
new = "    return true; // MUTATION: the window never holds anything"
assert s.count(old) == 1
p.write_text(s.replace(old, new))
