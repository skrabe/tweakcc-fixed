// Please see the note about writing patches in ./index

const OVERRIDE = '(+process.env.CLAUDE_CODE_CONTEXT_LIMIT||200000)';

export const writeContextLimit = (oldFile: string): string | null => {
  // CC >= ~2.1.18x split the single 200000 context-limit constant into TWO
  // adjacent ones: `var fkt=200000,KQ=200000,Akt=20000,MWu=32000,NWu=128000;`.
  //   - the 2nd (`KQ`) is the context window — used as `configured: KQ,
  //     source: "model-default"` and in the `vti(...) > KQ` exceeds-check;
  //   - the 1st (`fkt`) is the per-model token limit feeding `o = floor(fkt*n)`,
  //     and the effective window is `min(o, KQ)`.
  // Because the window is `min(o-from-fkt, KQ)`, RAISING the limit requires
  // overriding BOTH (overriding only one leaves the window capped by the other).
  // Env-unset → both stay 200000 → identical to stock CC.
  // Method 0 — CC >= 2.1.251: the trailing 1e6 left the group too, so the
  // declaration is back to four constants and reads
  // `var q8e=200000,g$=200000,Q3=32000,Z3=128000;`. The leading pair keeps its
  // roles (per-model default / `source:"model-default"` window); the trailing
  // two are the max-output default and upper bound, preserved verbatim. Must
  // be tried BEFORE method 3, whose four-constant shape has 20000 in slot 2 —
  // that one cannot match this, but keeping the newest shape first is the rule.
  const patternFour =
    /var ([$\w]+)=200000,([$\w]+)=200000,([$\w]+)=(32000),([$\w]+)=(128000|64000);/;
  const matchFour = oldFile.match(patternFour);
  if (matchFour) {
    return oldFile.replace(
      patternFour,
      () =>
        `var ${matchFour[1]}=${OVERRIDE},${matchFour[2]}=${OVERRIDE},${matchFour[3]}=${matchFour[4]},${matchFour[5]}=${matchFour[6]};`
    );
  }

  // Method 1 — CC ~2.1.21x-2.1.247: the 20000 constant was dropped from the
  // group and a 1e6 (the 1M-context ceiling) appended, so the declaration reads
  // `var _er=200000,bRe=200000,$Rg=32000,URg=128000,jRg=1e6;`. The first two
  // keep their roles (per-model default / `source:"model-default"` window);
  // the trailing three are max-output-default, max-output-upper and the 1M cap
  // and are preserved verbatim.
  const patternFive =
    /var ([$\w]+)=200000,([$\w]+)=200000,([$\w]+)=(32000),([$\w]+)=(128000|64000),([$\w]+)=(1e6|1000000);/;
  const matchFive = oldFile.match(patternFive);
  if (matchFive) {
    return oldFile.replace(
      patternFive,
      () =>
        `var ${matchFive[1]}=${OVERRIDE},${matchFive[2]}=${OVERRIDE},${matchFive[3]}=${matchFive[4]},${matchFive[5]}=${matchFive[6]},${matchFive[7]}=${matchFive[8]};`
    );
  }

  // Method 2 — CC ~2.1.18x-2.1.20x.
  const patternTwo =
    /var ([$\w]+)=200000,([$\w]+)=200000,([$\w]+)=20000,([$\w]+)=32000,([$\w]+)=(128000|64000);/;
  const matchTwo = oldFile.match(patternTwo);
  if (matchTwo) {
    return oldFile.replace(
      patternTwo,
      () =>
        `var ${matchTwo[1]}=${OVERRIDE},${matchTwo[2]}=${OVERRIDE},${matchTwo[3]}=20000,${matchTwo[4]}=32000,${matchTwo[5]}=${matchTwo[6]};`
    );
  }

  // Method 3 — older CC (a single 200000 constant).
  const patternOne =
    /var ([$\w]+)=200000,([$\w]+)=20000,([$\w]+)=32000,([$\w]+)=(128000|64000);/;
  const matchOne = oldFile.match(patternOne);
  if (matchOne) {
    return oldFile.replace(
      patternOne,
      () =>
        `var ${matchOne[1]}=${OVERRIDE},${matchOne[2]}=20000,${matchOne[3]}=32000,${matchOne[4]}=${matchOne[5]};`
    );
  }

  console.error('patch: contextLimit: failed to find context limit constants');
  return null;
};
