// Analog clock time picker (24-hour), like the Android alarm clock.
//
//   const picker = createClockPicker(element, { value: "21:00", onChange(v) {} });
//
// Step 1 picks the hour: outer ring 1–12, inner ring 13–00.
// Step 2 picks the minutes: tap a number (5-minute steps) or drag the hand
// for single minutes. Tap the big digits to switch back and forth.

const SIZE = 280, C = SIZE / 2, R_OUT = 112, R_IN = 74;

export function createClockPicker(root, { value = "21:00", onChange = () => {} } = {}) {
  let [hour, minute] = String(value).slice(0, 5).split(":").map(Number);
  let mode = "hour";

  root.classList.add("clock");
  root.innerHTML = `
    <div class="clock-digits" role="group" aria-label="Reminder time">
      <button type="button" class="clock-seg" data-seg="hour" aria-label="Hour"></button>
      <span aria-hidden="true">:</span>
      <button type="button" class="clock-seg" data-seg="minute" aria-label="Minutes"></button>
    </div>
    <div class="clock-face" style="width:${SIZE}px;height:${SIZE}px">
      <svg class="clock-hand" width="${SIZE}" height="${SIZE}" aria-hidden="true">
        <circle cx="${C}" cy="${C}" r="4"></circle>
        <line x1="${C}" y1="${C}"></line>
        <circle class="clock-knob" r="20"></circle>
      </svg>
      <div class="clock-numbers"></div>
    </div>`;

  const segH = root.querySelector('[data-seg="hour"]');
  const segM = root.querySelector('[data-seg="minute"]');
  const face = root.querySelector(".clock-face");
  const nums = root.querySelector(".clock-numbers");
  const line = root.querySelector("line");
  const knob = root.querySelector(".clock-knob");

  const pad = (n) => String(n).padStart(2, "0");
  const pos = (i, r) => {
    const a = (i / 12) * 2 * Math.PI;
    return { x: C + r * Math.sin(a), y: C - r * Math.cos(a) };
  };

  function numberButton(label, i, r, val, small) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "clock-num" + (small ? " small" : "");
    b.textContent = label;
    const p = pos(i, r);
    b.style.left = p.x + "px";
    b.style.top = p.y + "px";
    b.setAttribute("aria-label", mode === "hour" ? `${val} o'clock` : `${val} minutes`);
    b.addEventListener("click", () => set(val, true));
    return b;
  }

  function draw() {
    segH.textContent = pad(hour);
    segM.textContent = pad(minute);
    segH.classList.toggle("on", mode === "hour");
    segM.classList.toggle("on", mode === "minute");

    nums.replaceChildren();
    if (mode === "hour") {
      for (let i = 0; i < 12; i++) {
        const outer = i === 0 ? 12 : i;
        const inner = i === 0 ? 0 : i + 12;
        nums.append(numberButton(String(outer), i, R_OUT, outer, false));
        nums.append(numberButton(pad(inner), i, R_IN, inner, true));
      }
    } else {
      for (let i = 0; i < 12; i++) nums.append(numberButton(pad(i * 5), i, R_OUT, i * 5, false));
    }

    // the hand
    let i, r;
    if (mode === "hour") {
      const inner = hour === 0 || hour > 12;
      i = hour % 12;
      r = inner ? R_IN : R_OUT;
    } else {
      i = minute / 5;
      r = R_OUT;
    }
    const p = pos(i, r);
    line.setAttribute("x2", p.x);
    line.setAttribute("y2", p.y);
    knob.setAttribute("cx", p.x);
    knob.setAttribute("cy", p.y);
    for (const b of nums.children) {
      const sel = mode === "hour"
        ? Number(b.textContent) === hour || (b.textContent === "12" && hour === 12)
        : Number(b.textContent) === minute;
      b.classList.toggle("sel", sel);
    }
  }

  function set(val, fromTap) {
    if (mode === "hour") {
      hour = val;
      if (fromTap) mode = "minute";
    } else {
      minute = val;
      if (fromTap) onChange(current());
    }
    draw();
  }

  // Dragging the hand
  function fromPointer(e) {
    const rect = face.getBoundingClientRect();
    const x = e.clientX - rect.left - C, y = e.clientY - rect.top - C;
    let a = Math.atan2(x, -y);
    if (a < 0) a += 2 * Math.PI;
    const dist = Math.hypot(x, y);
    if (mode === "hour") {
      const i = Math.round((a / (2 * Math.PI)) * 12) % 12;
      const inner = dist < (R_IN + R_OUT) / 2;
      hour = inner ? (i === 0 ? 0 : i + 12) : (i === 0 ? 12 : i);
    } else {
      minute = Math.round((a / (2 * Math.PI)) * 60) % 60;
    }
    draw();
  }
  let dragging = false;
  face.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".clock-num")) return; // taps on numbers are handled by click
    dragging = true;
    face.setPointerCapture(e.pointerId);
    fromPointer(e);
  });
  face.addEventListener("pointermove", (e) => dragging && fromPointer(e));
  face.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    if (mode === "hour") { mode = "minute"; draw(); } else onChange(current());
  });

  segH.addEventListener("click", () => { mode = "hour"; draw(); });
  segM.addEventListener("click", () => { mode = "minute"; draw(); });

  function current() { return `${pad(hour)}:${pad(minute)}`; }

  draw();
  return {
    get value() { return current(); },
    set value(v) { [hour, minute] = String(v).slice(0, 5).split(":").map(Number); mode = "hour"; draw(); },
  };
}
