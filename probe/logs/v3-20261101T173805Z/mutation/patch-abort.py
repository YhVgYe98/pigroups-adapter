import sys, pathlib
d = pathlib.Path(sys.argv[1])
p = d / 'src/loop.ts'
s = p.read_text()
old = """    if (this.stopped) return;
    await this.flushOutcome(true);
    // 概念稿 §8.3 ①: the window's reason is gone once the work was cut, so whatever
    // the abort could not deliver (nothing was pending yet) goes out as soon as it
    // arrives. This is what makes "abort, then say" take effect immediately.
    this.windowImmediate = true;"""
new = """    if (this.stopped) return;
    // MUTATION: abort neither flushes nor arms the immediate window"""
assert s.count(old) == 1
p.write_text(s.replace(old, new))
