import sys, pathlib
d = pathlib.Path(sys.argv[1])
p = d / 'src/loop.ts'
s = p.read_text()
old = """    if (this.stopped) return 'stopped';
    // §3.2: an abort is cutting the turn."""
new = """    if (this.stopped) return 'stopped';
    if (this.surface.isBusy()) return 'waiting'; // MUTATION: the old isBusy() gate
    // §3.2: an abort is cutting the turn."""
assert s.count(old) == 1
p.write_text(s.replace(old, new))
