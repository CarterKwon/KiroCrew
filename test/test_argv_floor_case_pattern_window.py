"""Every argv window on the floor survives a ``case`` compound in its argv.

The six consumers of the substitution-depth walker each bound a different
window (the mint-verb scan, the ``pkill`` pattern leg, the bare-``kill`` body
window, the product CLI's operand list, the rsync environment walk and the
ssh-family argument walk).  Before ``_SubstitutionDepth`` they all shared one
blind spot: a ``case`` PATTERN's ``)`` scored as a substitution closer, so the
window closed at the first separator after ``esac`` and the argument that named
the target was never read.  Only the bare-``kill`` window had a compensation
(its raw-text re-derivation).

Each consumer gets the two measurements the issue asks for: the shape that
bash runs and the floor must deny, and a false-positive control -- an allowed
command carrying ``case ... esac`` followed by an unrelated command that
mentions the protected word -- that must stay allowed.  Verdicts go through the
public gate so the tests survive a refactor of how the floors are wired.
"""

from __future__ import annotations

import pytest

from kiro_crew.security import argv_floor, is_denied

_K = "k" + "ill"
_PK = "p" + _K
_NAME = "kiro" + "crew"
_TOK = "to" + "ken"

_RULE_KILL = "self-protection-" + _K
_RULE_MINT = "credential-exfil-" + _NAME + "-" + _TOK
_RULE_SSH = "sandbox-escape-ssh-self"
_RESTART = "re" + "start"
_RULE_RESTART = "self-protection-" + _RESTART

# The esac-tail body the issue measured, parametrised on the trailing command.
_TAIL = "case x in x) :;; esac; {cmd}"


def _rule(cmd: str) -> "str | None":
    verdict = is_denied(cmd)
    if verdict is None:
        return None
    return verdict.rsplit("rule=", 1)[1].split()[0]


class TestRowOneIsDeniedByTheTokenWindowAlone:
    """The issue's acceptance: revert the raw window locally, row 1 still denies."""

    ROW_ONE = f"{_K} $(" + _TAIL.format(cmd=f"pgrep -f {_NAME}") + ")"

    def test_with_the_raw_window_removed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(argv_floor, "_bare_" + _K + "_raw_bodies", lambda source: [])
        assert argv_floor._is_self_kill(self.ROW_ONE) is True

    def test_through_the_gate(self) -> None:
        assert _rule(self.ROW_ONE) == _RULE_KILL


class TestEveryConsumerReadsPastThePattern:
    """One denied shape per consumer whose target sits after ``esac``."""

    @pytest.mark.parametrize(
        ("cmd", "rule"),
        [
            # mint-verb scan: the verb after the substitution's esac-tail body
            (f"{_NAME} $(" + _TAIL.format(cmd="echo status") + f") {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in x|y) :;; esac; echo status) {_TOK}", _RULE_MINT),
            # the case WORD is itself a substitution spanning tokens, and the
            # body's ``)`` rides on ``esac`` -- the verb is the next word
            (f"{_NAME} $(case $(echo x) in x) :;; esac) {_TOK}", _RULE_MINT),
            # a QUOTED ``)`` as the pattern: de-quoted it is ``))``, and bash
            # refuses that unquoted, so the run is pattern text
            (f"{_NAME} $(case x in ')') :;; esac) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in 'x)') :;; esac; echo status) {_TOK}", _RULE_MINT),
            # newlines where bash allows them: before ``in``, before the first
            # pattern, before ``;;`` and before ``esac`` (a frame renders each
            # as a standalone ``;``)
            (f"{_NAME} $(case x\nin x) :;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in\nx) :;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in x)\n:;;\nesac; :) {_TOK}", _RULE_MINT),
            # an option-shaped pattern (``-c)``) the operand scan would skip
            (f"{_NAME} $(case $1 in -c) echo status;; esac) {_TOK}", _RULE_MINT),
            # the empty pattern de-quotes to a bare ``)`` and terminates
            (f"{_K} $(case x in '') :;; esac; pgrep -f {_NAME})", _RULE_KILL),
            # a ``)`` inside a parameter expansion, as the pattern and as a body word
            (f"{_NAME} $(case x in ${{v:-x)}}) :;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_PK} -f $(case x in ${{v:-x)}}) :;; esac; echo {_NAME})", _RULE_KILL),
            (f"{_NAME} $(: ${{v:-x)}}; echo status) {_TOK}", _RULE_MINT),
            # the expansion split across tokens by a blank (minted on the R9 head)
            (f"{_NAME} $(case x in x) : ${{v:-x y)}};; esac; :) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case ${{v:-x y)}} in x) :;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(: ${{v:-x y)}}; echo status) {_TOK}", _RULE_MINT),
            (f"{_PK} -f $(case x in x) : ${{v:-x y)}};; esac; printf {_NAME})", _RULE_KILL),
            ("rsync -e ssh $(case x in x) : ${v:-x y)};; esac; echo src) 127.0.0.1:/x", _RULE_SSH),
            # the case WORD is a process substitution: its ``)`` is not the window's
            (f"{_NAME} $(case <(printf x) in *) :;; esac) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case <(printf x) in *) :;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_PK} -f $(case >(cat) in *) :;; esac; echo {_NAME})", _RULE_KILL),
            # ``case`` glued to a control operator, and ``esac`` as a quoted pattern
            (f"{_NAME} $(:;case x in x) :;; esac; echo status) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(x&&case x in x) :;; esac; echo status) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in x) :;; esac;case y in y) :;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_K} $(case x in x) :;; esac;case y in y) :;; esac; pgrep -f {_NAME})", _RULE_KILL),
            (f"{_NAME} $(case x in x) : ${{v:-x) y}};; esac; :) {_TOK}", _RULE_MINT),
            (f"{_K} $(pgrep -f 'sync-${{ENV'; pgrep -f {_NAME})", _RULE_KILL),
            # the next pattern glued to ``;;``, and the first pattern glued to ``in``
            (f"{_NAME} $(case x in x) :;;y) :;; esac) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in(x) :;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_K} $(case x in x) :;;y) :;; esac; pgrep -f {_NAME})", _RULE_KILL),
            ("rsync -e ssh $(case x in 'esac') :;; esac; echo src) 127.0.0.1:/x", _RULE_SSH),
            # a quoted ``esac`` pattern with an EMPTY body: ``esac);;`` is one token
            (f"{_NAME} $(case x in 'esac');; esac; echo status) {_TOK}", _RULE_MINT),
            (f"{_PK} -f $(case x in 'esac');; esac; echo {_NAME})", _RULE_KILL),
            ("rsync -e ssh $(case x in 'esac');; esac; echo src) 127.0.0.1:/x", _RULE_SSH),
            # a nested ``case`` glued to the outer pattern
            (f"{_NAME} $(case x in x)case y in y) :;; esac;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case $(echo x) in x) :;; esac; echo status) {_TOK}", _RULE_MINT),
            # pkill pattern leg: the name is produced INSIDE the body, after esac
            (f"{_PK} -f $(" + _TAIL.format(cmd=f"echo {_NAME}") + ")", _RULE_KILL),
            (f"{_PK} -f $(case $(echo x) in x) :;; esac; echo {_NAME})", _RULE_KILL),
            # bare kill body window (row 1 of the issue, plus the paren-pattern spelling)
            (f"{_K} $(" + _TAIL.format(cmd=f"pgrep -f {_NAME}") + ")", _RULE_KILL),
            (f"{_K} $(case x in (x) :;; esac; pgrep -f {_NAME})", _RULE_KILL),
            # ssh-family argument walk: the self-host operand after the body
            ("rsync -e ssh $(" + _TAIL.format(cmd="echo src") + ") 127.0.0.1:/x", _RULE_SSH),
            # a quoted ``)`` inside a bracket pattern (R10: ``x[\\)]|x)`` minted)
            (f"{_NAME} $(case x in x[\\)]|x) :;; esac; echo status) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in [[:alpha:]\\)]) :;; esac; echo status) {_TOK}", _RULE_MINT),
            (f"{_PK} -f $(case x in x[\\)]|x) :;; esac; echo {_NAME})", _RULE_KILL),
            ("rsync -e ssh $(case x in x[\\)]|x) :;; esac; echo src) 127.0.0.1:/x", _RULE_SSH),
            # the self host AFTER the substitution: a word opening or inside ``$( )``
            # is not the ssh destination, so the positional slot is still open
            ("ssh $(case x in x) echo -v;; esac) localhost", _RULE_SSH),
            ("ssh -p $(case x in 22) echo 22;; esac) localhost", _RULE_SSH),
            ("scp $(case x in a) echo a;; *) echo b;; esac) localhost:/x", _RULE_SSH),
            ("rsync -e ssh $(case x in a) echo -z;; *) echo -v;; esac) f 127.0.0.1:/x", _RULE_SSH),
            ("ssh $(echo -v) localhost", _RULE_SSH),  # the plain spelling, allowed on base
            # a body word that spells the self host is still checked (fail-closed)
            ("scp $(case x in a) echo a;; *) echo localhost;; esac) host:/x", _RULE_SSH),
            # a backtick-spelled case (R10: ``\`case`` read as the word with depth 0)
            (f"{_NAME} `case x in x) :;; esac; :` {_TOK}", _RULE_MINT),
            # a backtick substitution as the pattern, with a quoted ``)`` inside (R12)
            (f"{_NAME} $(case x in `printf ')'`) :;; esac; echo status) {_TOK}", _RULE_MINT),
            (f"{_PK} -f $(case x in `printf ')'`) :;; esac; echo {_NAME})", _RULE_KILL),
            # a prefixed opener (R12: ``$x$(case`` armed nothing)
            (f"{_NAME} $x$(case y in y) :;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_PK} -f $x$(case y in y) :;; esac; echo {_NAME})", _RULE_KILL),
            (f"{_K} x$(case y in y) :;; esac; pgrep -f {_NAME})", _RULE_KILL),
            # a case INSIDE a pattern substitution: its pattern's ``)`` is its own (R14
            # GPT: the inner ``y)`` closed the outer substitution and the verb minted)
            (f"{_NAME} $(case x in $(case y in y) :;; esac)) :;; esac; :) {_TOK}", _RULE_MINT),
            (
                f"{_NAME} $(case x in $(case y in y) :;; esac; case z in z) :;; esac)) "
                f":;; esac) {_TOK}",
                _RULE_MINT,
            ),
            (f'{_NAME} $(case x in "$(case y in y) :;; esac)"|x) :;; esac; :) {_TOK}', _RULE_MINT),
            (f"{_PK} -f $(case x in $(case y in y) :;; esac)) :;; esac; echo {_NAME})", _RULE_KILL),
            (f"{_K} $(case x in `case y in y) :;; esac`) :;; esac; pgrep -f {_NAME})", _RULE_KILL),
            # a quoted ``'esac'`` as a body command, and as a pattern with a blank before ``)``
            (f"{_NAME} $(case x in x) 'esac';; y) :;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in 'esac' ) :;; esac; :) {_TOK}", _RULE_MINT),
            # a quoted ``'${'`` literal is a WORD (R14 Opus: rewritten to ``{``, read as
            # a function-body opener, the window ended before the target)
            (f"{_NAME} '${{' to$()ken", _RULE_MINT),
            (f"{_K}all '${{' kiro$()crew", _RULE_KILL),
            (f"{_K}all '${{' >/dev/null {_NAME}", _RULE_KILL),
            # the top-level text glued after a substitution's closer is the word bash
            # hands over (R15 GPT: the whole token ``esac)<verb>`` was classified)
            (f"{_NAME} $(case x in x) :;; esac){_TOK}", _RULE_MINT),
            (f"{_NAME} $(true; :){_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in x) :;; esac){_RESTART}", _RULE_RESTART),
            (f"{_NAME} $(: ; :) {_RESTART}", _RULE_RESTART),
            # a substitution opened in a REDIRECT word is still a command list this
            # window reads through (R15 GPT: the data token never advanced the walker)
            (f"{_NAME} 2>$(case x in x) :;; esac; echo /dev/null) {_RESTART}", _RULE_RESTART),
            (f"{_NAME} 2> $(: ; echo /dev/null) {_RESTART}", _RULE_RESTART),
            (f"{_NAME} 2>$(: ; echo /dev/null) {_TOK}", _RULE_MINT),
            # a keeper in ARGUMENT position is a word, not a hand-through (R15 Opus:
            # ``time`` armed a phantom case and the host slot was never checked)
            ("scp /etc/passwd time case x in localhost:/tmp/", _RULE_SSH),
            (f"{_PK} -f time case x in {_NAME}", _RULE_KILL),
            # the token that POPS the substitution carries the host glued after it
            # (R15 Opus: ``top_level`` was read before the token was fed)
            ("ssh -C $(: )localhost", _RULE_SSH),
            ("ssh $(: )localhost", _RULE_SSH),
            ("ssh -v $(: )localhost uptime", _RULE_SSH),
            # a substitution whose output IS the self host, statically
            ("ssh $(printf 127.0.0.1) uptime", _RULE_SSH),
            ("ssh $(echo localhost) uptime", _RULE_SSH),
            # scp/rsync check every operand, a substitution's body words included (base)
            ("scp file $(grep -v localhost hosts):/tmp/", _RULE_SSH),
            # a quoted ``'esac')`` PATTERN with a clause body (R16 GPT: read as the
            # closer, the body's ``;`` ended the window before the real closer)
            (f"{_NAME} $(case x in 'esac') echo hi; :;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in 'esac') echo hi; esac; :) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in 'esac')\n echo hi;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in 'esac') >/dev/null;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in 'esac')$(echo hi);; esac; :) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(case x in x) :;; 'esac') echo hi; :;; esac; :) {_TOK}", _RULE_MINT),
            (f"{_K} $(case x in 'esac') echo hi; :;; esac; pgrep -f {_NAME})", _RULE_KILL),
            (f"{_K}all $(case x in 'esac') echo hi; :;; esac; echo nginx) {_NAME}", _RULE_KILL),
            ("ssh $(case x in 'esac') echo -v;; esac; :) localhost", _RULE_SSH),
            # a ``#`` behind a quoted blank is data, not a comment (R16 Opus: the
            # de-quoted ``a #`` ended the window and the verb behind it minted)
            (f"{_NAME} >'a #' {_TOK}", _RULE_MINT),
            (f"{_NAME} 'a #' {_TOK}", _RULE_MINT),
            (f"{_K}all 'a #' {_NAME}", _RULE_KILL),
            # a QUOTED grammar word is an argument to bash, so the substitution's
            # ``)`` is its closer and the operand behind it is this command's
            # (R17 GPT: de-quoted ``case`` armed a pattern, ``)`` ended the pattern,
            # the self host was never read).  Every quoting spelling, every floor.
            ('ssh $("case" x in y 2>/dev/null) localhost', _RULE_SSH),
            ("ssh $('case' x in y 2>/dev/null) localhost", _RULE_SSH),
            ("ssh $(\\case x in y) localhost", _RULE_SSH),
            ("ssh $($'case' x in y) localhost", _RULE_SSH),
            ('ssh $(ca"se" x in y) localhost', _RULE_SSH),
            ("ssh $(c'a'se x in y) localhost", _RULE_SSH),
            ('ssh $("time" case x in y) localhost', _RULE_SSH),
            ('ssh $(x; "case" x in y) localhost', _RULE_SSH),
            ('ssh $(case x "in" y) localhost', _RULE_SSH),
            ('ssh $("if" case x in y) localhost', _RULE_SSH),
            ('scp $("case" x in y) file localhost:/tmp/', _RULE_SSH),
            (f'{_NAME} $("case" x in y) {_RESTART}', _RULE_RESTART),
            (f"{_NAME} $('case' x in y) {_TOK}", _RULE_MINT),
            (f"{_NAME} $(\\case x in y) {_RESTART}", _RULE_RESTART),
            (f'{_PK} -f $("case" x in y) {_NAME}', _RULE_KILL),
            (f'{_K} $("case" x in y) $(pgrep -f {_NAME})', _RULE_KILL),
            # the host glued behind the closer of a substitution whose output is not
            # static is the destination when that output is empty (R18 GPT: the
            # token closing ``esac)`` was skipped as grammar and ``localhost`` behind
            # it never read; the one-token ``$(true)localhost`` read only as a whole)
            ("ssh $(case x in x) :;; esac)localhost", _RULE_SSH),
            ("ssh -v $(case x in x) :;; esac)localhost uptime", _RULE_SSH),
            ("ssh $(case x in x) :;; esac)127.0.0.1", _RULE_SSH),
            ("ssh user@$(case x in x|y) :;; esac)localhost", _RULE_SSH),
            ("ssh $(true)localhost", _RULE_SSH),
            ("ssh `true`localhost", _RULE_SSH),
            ("ssh user@$(true)localhost", _RULE_SSH),
            ("ssh $(true)local$(true)host", _RULE_SSH),
            ("ssh -C $(true)localhost uptime", _RULE_SSH),
            ("sftp $(true)localhost", _RULE_SSH),
            ("scp file $(true)localhost:/tmp/", _RULE_SSH),
            ("scp $(case x in x) :;; esac)localhost:/x /tmp/", _RULE_SSH),
            ("rsync -a . $(case x in x) :;; esac)localhost:/tmp/", _RULE_SSH),
            # the value of an option that consumes one is checked the same way
            ("ssh -o $(true)localhost build-host", _RULE_SSH),
        ],
    )
    def test_denied(self, cmd: str, rule: str) -> None:
        assert _rule(cmd) == rule


class TestAnUnrelatedLaterCommandIsNotAttributed:
    """False-positive controls, one per consumer: the case ends, the argv ends."""

    @pytest.mark.parametrize(
        "cmd",
        [
            # mint-verb scan
            f"{_NAME} status $(case x in a) echo b;; esac); echo {_TOK}",
            f"{_NAME} status $(case x in a|b) echo c;; esac); echo {_TOK}",
            # pkill pattern leg
            f"{_PK} -f $(" + _TAIL.format(cmd="echo other") + f"); echo {_NAME}",
            f"{_PK} -f other; " + _TAIL.format(cmd=f"echo {_NAME}"),
            # bare kill body window
            f"{_K} $(" + _TAIL.format(cmd="pgrep -f other") + f"); echo {_NAME}",
            f"{_K} 123; " + _TAIL.format(cmd=f"echo {_NAME}"),
            f"{_K} $(case x in a) :;; esac>/dev/null); echo {_NAME}",
            # ``esac`` after a newline still ends the compound, so the window ends
            f"{_K} $(case x in x) :;;\nesac); echo {_NAME}",
            f"{_K} $(case x in x) :;;\nesac; pgrep -f other); echo {_NAME}",
            f"{_K} $(case x\nin x) :;; esac; pgrep -f other); echo {_NAME}",
            # the EMPTY pattern (``'')``) terminates: the window ends at the ``;`` after esac
            f"{_PK} -f $(case $x in '') echo foo;; esac); cd ~/{_NAME}",
            "rsync -e ssh $(case $x in '') echo src;; esac) remotebox:/x; echo 127.0.0.1",
            # an option-shaped pattern is fed to the walker even though the operand
            # scan skips it, so the pattern closes and the window ends at ``esac);``
            f"{_NAME} status $(case $1 in -c) echo hi;; esac); grep {_TOK} log",
            f"{_NAME} status $(case $1 in -c) echo hi;; esac) restart",
            # ``esac)`` closing both the case and the substitution stays a closer
            f"{_K} $(case x in x) :;; esac); :;; echo {_NAME}",
            f"{_K} $(pgrep -f x;case y in y) :;; esac); echo {_NAME}",
            f"{_K} $(case x in x) :;; esac;case y in y) :;; esac); echo {_NAME}",
            # a quoted, never-closed ``${`` inside the substitution (scope corpus row)
            f"{_K} $(pgrep -f 'sync-${{ENV'); {_NAME} status",
            f'{_K} $(pgrep -f "sync-${{ENV"); {_NAME} status',
            f"{_K} $(grep -c '${{' conf.tpl); echo {_NAME}",
            f"{_K} $(case x in x) :;;y) :;; esac); echo {_NAME}",
            f"{_K} $(case x in(x) :;; esac); echo {_NAME}",
            # an expansion's own ``)`` does not keep the window open past the ``;``
            f"{_K} ${{v:-x)}}; echo {_NAME}",
            f"{_K} ${{PIDS:-$(pgrep x)}}; echo {_NAME}",
            f"{_K} ${{PIDS:-$(pgrep x; echo 1)}}; echo {_NAME}",
            # a split expansion is carried to its ``}`` and no further
            f"{_K} ${{v:-a b)}}; echo {_NAME}",
            f"{_K} $(: ${{v:-a b}}); echo {_NAME}",
            f"{_NAME} ${{v:-a b)}} status; echo {_TOK}",
            f"{_PK} -f other ${{v:-a b}}; echo {_NAME}",
            # a balanced process substitution closes itself; the argv still ends
            f"{_K} $(pgrep nginx) <(echo); echo {_NAME}",
            f"diff <(ls) <(ls -a); echo {_NAME} {_TOK}",
            # product CLI operands: the leading operand decides, a case body in
            # the argv does not make ``restart`` leading
            f"{_NAME} status $(case x in a) echo b;; esac) restart",
            # rsync environment walk: a pattern alternation is not a separator
            # and the selector never crosses the compound
            "case $x in a|b) rsync -e ssh x y;; esac; echo localhost",
            "case $x in a|b) rsync x remotebox:/y;; esac; echo 127.0.0.1",
            # a quoted ``'${'`` literal at top level and a ``$case`` parameter end
            # the argv where the counter did (R10 walked on past the ``;``)
            f"{_PK} -f '${{a' ; echo {_NAME}",
            f"{_K} '${{' 1; echo {_NAME}",
            f"{_PK} -f $case ; echo {_NAME}",
            # bracket patterns: the window still ends at the ``)`` after the ``]``
            f"{_NAME} status $(case x in [a-z]) echo a;; esac); echo {_TOK}",
            f"{_NAME} status $(case x in x[\\)]) echo a;; esac); echo {_TOK}",
            f"{_NAME} status $(case x in [$(echo ])]) echo a;; esac); echo {_TOK}",
            f"{_NAME} status $(case x in x[) echo a;; esac); echo {_TOK}",
            f"{_PK} -f $(case x in [a-z\\)]) :;; esac; echo other); echo {_NAME}",
            f"case $x in [a-z\\)]) echo a;; esac; {_NAME} status",
            # a ``}`` with no ``)`` after it leaves the ``'${'`` literal quoted (R12 denied)
            f"{_K} $(grep -c '${{' x); awk '{{print}}' y; cd ~/{_NAME}",
            # 500 glued clauses in one token (R12 raised ``RecursionError`` out of the gate)
            f"{_K} $(case x in " + "x);;" * 500 + "esac)",
            # ssh-family argument walk
            "ssh host $(" + _TAIL.format(cmd="echo hi") + "); echo localhost",
            "rsync -e ssh $(" + _TAIL.format(cmd="echo src") + ") remotebox:/x; echo 127.0.0.1",
            "scp $(" + _TAIL.format(cmd="echo f") + ") remotebox:/x; echo localhost",
            # a glob PATTERN is grammar, not a host operand (``*`` matches every self
            # name; the scope corpus rows R13 newly refused)
            'rsync -e ssh $(case "$c" in y) echo -z;; *) echo -v;; esac) ./src backup-host:/srv',
            'scp $(case "$f" in tar) echo out.tar;; *) echo out.txt;; esac) deploy-host:/incoming',
            "scp $(case x in *) echo out.txt;; esac) deploy-host:/incoming",
            "scp $(case localhost in x) echo a;; esac) remotebox:/x",
            "scp $(case x in a) echo a;; localhost) echo b;; esac) remotebox:/x",
            # an opaque destination keeps the slot open, and the remote command is not a host
            "ssh $(get-host) uptime",
            "ssh $(case $e in p) echo bastion-a;; *) echo bastion-b;; esac) uptime",
            "ssh -p 22 $(get-host) 'echo hi'",
            "ssh remotebox $(cmd) localhost",
            # a word INSIDE the substitution is that command's argv, not the host slot
            # (R14 Opus: ``hosts.txt`` resolved as the destination, fail-closed)
            "ssh $(cat hosts.txt | head -1) uptime",
            "ssh $(cat hosts.txt) uptime",
            # an expansion inside an expansion closes where bash closes it (R14 Opus:
            # the inner's open ``$(`` count was doubled into the outer, never closed)
            f"{_K} ${{PIDS:-$(pgrep -f ${{SVC}})}}; echo {_NAME}",
            # a case inside a pattern substitution still lets the outer one close
            f"{_K} $(case x in $(case y in y) :;; esac)) :;; esac); echo {_NAME}",
            # a redirect word's COMPLETE substitution and a quoted target's separator
            # are data: the window still ends at the real separator
            f"{_NAME} status 2>$(mktemp); echo {_TOK}",
            f"{_NAME} > 'a;b' status; echo {_TOK}",
            f"{_NAME} 2>$(mktemp) status",
            # a keeper in argument position: ``time case x in y`` is the remote command
            "ssh remotebox time case x in y",
            # a self name inside an ssh substitution body only EXCLUDES it: the body
            # is that command's argv, not an operand (R16 scope rows, allowed on base)
            "ssh $(grep -v localhost /etc/hosts | awk 'NR==1{print $2}') uptime",
            "ssh $(cat hosts.txt | grep -v 127.0.0.1 | head -1) uptime",
            "ssh $(findstr /V localhost hosts.txt) uptime",
            # ``esac)`` as the closer: a word, then the window ends at the ``;`` -- the
            # rest reads as valid bash under the closer reading (R16)
            f"{_NAME} $(case x in x) :;; esac) status; echo {_TOK}",
            f"{_K}all $(case x in x) :;; esac) nginx; echo {_NAME}",
            f"{_K} $(case x in x) :;; esac)\n echo {_NAME}",
            f"{_K} $(case x in x) :;; esac) 1; echo {_NAME} $(date)",
            # a ``#`` that STARTS the token is a comment (as on base)
            f"{_NAME} '#' {_TOK}",
            # a quoted grammar word as an OPERAND compares as its text (R17): a
            # mint-free CLI operand, a kill of another name
            f'{_NAME} "case" status',
            f'{_NAME} $("case" x in y) status',
            f'{_K}all "case" nginx',
            # a glued word that names another host, or no host at all (R18)
            "ssh $(case x in x) :;; esac)build-host uptime",
            "ssh $(true)build-host",
            "ssh $(echo x)y",
            "scp file $(true)build-host:/tmp/",
            "ssh build-host $(true)localhost",
            "ssh -l $(true)localhost build-host",
            "ssh -p $(true)2222 build-host",
            "ssh $(case x in x) :;; esac)",
            # the UNQUOTED spelling keeps the compound reading (as on the base): the
            # pattern's ``)`` is grammar and ``localhost`` sits in the clause body of
            # a command bash refuses without ``esac``
            "ssh $(case x in y) localhost",
        ],
    )
    def test_allowed(self, cmd: str) -> None:
        assert _rule(cmd) is None


class TestAClauseTerminatorAfterEsacStaysOpen:
    """DOCUMENTED LIMIT, fail-closed.  ``esac);;`` (glued or not) is token-identical
    for a quoted ``'esac')`` pattern with an empty body and for a closed case whose
    ``$(`` ends inside an ENCLOSING clause the window never saw; bash refuses ``;;``
    after a closed case otherwise.  The walker keeps the window open (deny direction);
    R13 read the glued spelling as a closer and the quoted pattern minted (GPT)."""

    @pytest.mark.parametrize("gap", ["", " "])
    def test_the_enclosing_clause_shape_is_over_scanned(self, gap: str) -> None:
        cmd = f"case a in a) {_K} $(case x in x) :;; esac){gap};; esac; echo {_NAME}"
        assert _rule(cmd) == _RULE_KILL
        assert _rule(cmd.replace(f"echo {_NAME}", "echo other")) is None
