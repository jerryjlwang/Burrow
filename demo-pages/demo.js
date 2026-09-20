// Tiny page logic for the demo LMS. No frameworks; deliberately realistic markup.
(function () {
  // ---- Practice problems (algebra.html) ----
  var problems = [
    { text: "3x + 5 = 20", answer: 5 },
    { text: "2x − 4 = 10", answer: 7 },
  ];
  var eq = document.getElementById("equation");
  if (eq) {
    var idx = 0, attempts = 0;
    var input = document.getElementById("answer");
    var check = document.getElementById("check");
    var next = document.getElementById("next");
    var finish = document.getElementById("finish");
    var feedback = document.getElementById("feedback");
    var attemptsEl = document.getElementById("attempts");
    var qnum = document.getElementById("q-num");
    function render() {
      eq.textContent = problems[idx].text;
      qnum.textContent = String(idx + 1);
      input.value = "";
      attempts = 0;
      feedback.className = "feedback";
      feedback.textContent = "";
      attemptsEl.textContent = "";
      next.hidden = true;
      check.disabled = false;
      input.focus();
    }
    function checkAnswer() {
      var v = parseFloat(String(input.value).replace(/[^0-9.\-]/g, ""));
      attempts++;
      if (v === problems[idx].answer) {
        feedback.className = "feedback success show";
        feedback.textContent = "Correct! x = " + problems[idx].answer + ". Nice work.";
        attemptsEl.textContent = "Solved in " + attempts + (attempts === 1 ? " try." : " tries.");
        check.disabled = true;
        if (idx < problems.length - 1) next.hidden = false;
        else finish.hidden = false;
      } else {
        feedback.className = "feedback error show";
        feedback.textContent = isNaN(v) ? "Please enter a number." : "Not quite — try again.";
        attemptsEl.textContent = "Attempts: " + attempts;
        input.select();
      }
    }
    check.addEventListener("click", checkAnswer);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") checkAnswer(); });
    next.addEventListener("click", function () { idx++; render(); });
    render();
  }

  // ---- Quiz (quiz.html) ----
  var cont = document.getElementById("continue");
  if (cont) {
    var q1 = document.querySelectorAll('input[name="q1"]');
    var q2 = document.getElementById("q2");
    var status = document.getElementById("quiz-status");
    q1.forEach(function (r) { r.addEventListener("change", function () { cont.removeAttribute("aria-disabled"); }); });
    cont.addEventListener("click", function () {
      if (cont.getAttribute("aria-disabled") === "true") return; // looks disabled, does nothing
      q2.hidden = false;
      cont.hidden = true;
      q2.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    document.getElementById("save-quiz").addEventListener("click", function () {
      status.textContent = "Draft saved.";
      status.classList.add("show");
    });
    document.getElementById("submit-quiz").addEventListener("click", function () {
      status.textContent = "Quiz submitted. Your score will appear in Grades.";
      status.classList.add("show");
      status.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  // ---- Assignment (assignment.html) ----
  var submitA = document.getElementById("submit-assignment");
  if (submitA) {
    var aStatus = document.getElementById("assignment-status");
    document.getElementById("save-draft").addEventListener("click", function () {
      aStatus.textContent = "Draft saved.";
      aStatus.classList.add("show");
    });
    submitA.addEventListener("click", function () {
      aStatus.textContent = "Assignment submitted. Nice work!";
      aStatus.classList.add("show");
    });
  }

  // ---- Sign in (signin.html) ----
  var signin = document.getElementById("signin");
  if (signin) {
    signin.addEventListener("submit", function () {
      var email = document.getElementById("email").value || "student";
      var s = document.getElementById("signin-status");
      s.textContent = "Signed in as " + email + " (demo — nothing is really sent).";
      s.classList.add("show");
    });
  }
})();
