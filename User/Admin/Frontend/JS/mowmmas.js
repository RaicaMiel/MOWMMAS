/* MOWMMAS Admin — shared interface behaviour.
   Everything here is driven by data attributes and only enhances the page:
   every page works with JavaScript turned off. Load it in <head> without
   defer, so the .has-js class is set before the page first paints. */

(function () {
  "use strict";

  document.documentElement.classList.add("has-js");

  document.addEventListener("DOMContentLoaded", function () {
    markCurrentPage();
    initPasswordToggles();
    initRequiredCheck();
    initDrawers();
    initModals();
    initToasts();
    initTabs();
    initSubnavs();
    initLiveText();
    initFlashes();
  });

  /* Current page in the sidebar
     <body data-page="dashboard"> gives <a data-nav="dashboard"> aria-current="page".
     The highlight itself is CSS, so it shows without JavaScript too. */
  function markCurrentPage() {
    var page = document.body.dataset.page;
    if (!page) return;

    document.querySelectorAll("[data-nav]").forEach(function (link) {
      if (link.dataset.nav === page) link.setAttribute("aria-current", "page");
    });
  }

  /* Password toggle
     <button type="button" data-password-toggle aria-controls="password" aria-pressed="false" hidden>
     The button ships hidden because it does nothing without JavaScript. */
  function initPasswordToggles() {
    document.querySelectorAll("[data-password-toggle]").forEach(function (button) {
      var input = document.getElementById(button.getAttribute("aria-controls"));
      if (!input) return;

      button.hidden = false;
      button.addEventListener("click", function () {
        var show = input.type === "password";
        input.type = show ? "text" : "password";
        button.setAttribute("aria-pressed", String(show));
      });
    });
  }

  /* Required-field check for <form data-validate>
     On submit, empty required fields get .has-error on their .mw-field and
     their hidden .mw-field__error is revealed. A valid form submits normally.
     An error clears once its field is filled in, and when the form resets. */
  function initRequiredCheck() {
    document.querySelectorAll("form[data-validate]").forEach(function (form) {
      form.noValidate = true;

      form.addEventListener("submit", function (event) {
        var firstEmpty = null;

        form.querySelectorAll("[required]:not(:disabled)").forEach(function (control) {
          var empty = isEmpty(control);
          setFieldError(control, empty);
          if (empty && !firstEmpty) firstEmpty = control;
        });

        if (firstEmpty) {
          event.preventDefault();
          firstEmpty.focus();
        }
      });

      // A field's error goes away once it's filled in.
      function clearFixed(event) {
        var control = event.target;
        if (control.getAttribute("aria-invalid") === "true" && !isEmpty(control)) {
          setFieldError(control, false);
        }
      }
      form.addEventListener("input", clearFixed);
      form.addEventListener("change", clearFixed);

      // Closing a modal resets its form, so the errors go too.
      form.addEventListener("reset", function () {
        form.querySelectorAll("[required]").forEach(function (control) {
          setFieldError(control, false);
        });
      });
    });
  }

  function isEmpty(control) {
    if (control.type === "checkbox") return !control.checked;
    // Spaces count in a password, even while the toggle shows it as text.
    var isPassword = control.type === "password" || /password/.test(control.getAttribute("autocomplete") || "");
    if (isPassword) return control.value === "";
    return control.value.trim() === "";
  }

  function setFieldError(control, hasError) {
    if (hasError) {
      control.setAttribute("aria-invalid", "true");
    } else {
      control.removeAttribute("aria-invalid");
    }

    var field = control.closest(".mw-field");
    if (!field) return;

    field.classList.toggle("has-error", hasError);
    var message = field.querySelector(".mw-field__error");
    if (message) message.hidden = !hasError;
  }

  /* Drawer (the sidebar below 1024px)
     <button data-drawer-toggle aria-controls="sidebar" aria-expanded="false" hidden> opens it.
     Every [data-drawer-close] closes it: buttons inside the drawer (revealed
     here) and the backdrop next to it (shown only while open). While it is
     open everything outside it is inert (the skip link included), Esc closes
     it, and focus goes back to the toggle. Dialogs stay usable: one opened
     from the drawer (e.g. Sign out) sits above it, and Esc closes only the dialog. */
  function initDrawers() {
    var narrow = window.matchMedia("(max-width: 1023px)");

    document.querySelectorAll("[data-drawer-toggle]").forEach(function (toggle) {
      var drawer = document.getElementById(toggle.getAttribute("aria-controls"));
      if (!drawer) return;

      var closers = Array.from(document.querySelectorAll("[data-drawer-close]"));
      var backdrops = closers.filter(function (el) { return !drawer.contains(el); });
      // Everything beside the drawer, and beside each of its ancestors up to <body>.
      // Not the dialogs: an inert dialog opened from the drawer couldn't be used.
      var background = [];
      for (var node = drawer; node !== document.body && node.parentElement; node = node.parentElement) {
        Array.from(node.parentElement.children).forEach(function (el) {
          if (el !== node && backdrops.indexOf(el) === -1 && el.tagName !== "SCRIPT" && el.tagName !== "DIALOG") background.push(el);
        });
      }

      function setOpen(open, returnFocus) {
        drawer.classList.toggle("is-open", open);
        toggle.setAttribute("aria-expanded", String(open));
        document.body.classList.toggle("has-drawer-open", open);
        backdrops.forEach(function (el) { el.hidden = !open; });
        background.forEach(function (el) { el.inert = open; });

        if (open) {
          var first = drawer.querySelector("[data-drawer-close], a, button");
          if (first) first.focus();
        } else if (returnFocus) {
          toggle.focus();
        }
      }

      function isOpen() {
        return drawer.classList.contains("is-open");
      }

      toggle.hidden = false;
      closers.forEach(function (el) {
        if (drawer.contains(el)) el.hidden = false;
        el.addEventListener("click", function () { setOpen(false, true); });
      });

      toggle.addEventListener("click", function () { setOpen(true); });

      document.addEventListener("keydown", function (event) {
        // With a dialog open, Esc is the dialog's: the drawer stays as it was.
        if (event.key === "Escape" && isOpen() && !document.querySelector("dialog[open]")) setOpen(false, true);
      });

      // Widening past the breakpoint turns the drawer back into a sidebar.
      narrow.addEventListener("change", function (event) {
        if (!event.matches && isOpen()) setOpen(false, false);
      });
    });
  }

  /* Modals
     A trigger opens <dialog class="mw-modal" id="…"> with showModal(), which
     moves focus in, keeps it there and closes on Esc:
       <button type="button" data-modal-open="update_status_modal" hidden>
     A button trigger ships hidden and is revealed here, because it does nothing
     without JavaScript. A link trigger (<a href="login.html" data-modal-open="…">)
     stays visible and simply follows its link when the script isn't running.
     [data-modal-close] and a click on the backdrop close the dialog, the form
     resets, and focus goes back to the trigger.
     The trigger can also fill the dialog in:
       data-modal-heading="…"    text of [data-modal-heading-target], e.g. "Edit facility"
       data-modal-context="…"    text of every [data-modal-context-target], e.g. a name
       data-modal-value="…"      value of every [data-modal-value-target] field
       data-modal-field-<id>="…" value of the field with that id ("true"/"false" for a checkbox) */
  function initModals() {
    document.querySelectorAll("[data-modal-open]").forEach(function (trigger) {
      var dialog = document.getElementById(trigger.getAttribute("data-modal-open"));
      if (!dialog || typeof dialog.showModal !== "function") return;
      if (trigger.tagName === "BUTTON") trigger.hidden = false;
    });

    // One listener for every trigger, including ones a page script adds later
    // (e.g. table rows drawn from Firestore). A page script that opens a
    // trigger's dialog itself calls event.preventDefault() first. Just before
    // the dialog opens it gets an "mw:modal-open" event with the trigger in
    // event.detail.trigger, so a page can add its own touches.
    document.addEventListener("click", function (event) {
      if (event.defaultPrevented) return;
      var trigger = event.target.closest && event.target.closest("[data-modal-open]");
      if (!trigger) return;
      var dialog = document.getElementById(trigger.getAttribute("data-modal-open"));
      if (!dialog || typeof dialog.showModal !== "function" || dialog.open) return;
      event.preventDefault();
      fillDialog(dialog, trigger);
      dialog.returnFocusTo = trigger;
      dialog.dispatchEvent(new CustomEvent("mw:modal-open", { detail: { trigger: trigger } }));
      dialog.showModal();
    });

    document.querySelectorAll("dialog.mw-modal").forEach(function (dialog) {
      dialog.querySelectorAll("[data-modal-close]").forEach(function (button) {
        button.addEventListener("click", function () { dialog.close(); });
      });

      // The dialog box fills its own padding, so a pointer event on the dialog
      // element itself is on the backdrop. Only a press and a release that are
      // both on the backdrop close it, so a drag into or out of a field doesn't.
      var pressedBackdrop = false;
      var releasedBackdrop = false;
      dialog.addEventListener("pointerdown", function (event) {
        pressedBackdrop = event.target === dialog;
      });
      dialog.addEventListener("pointerup", function (event) {
        releasedBackdrop = event.target === dialog;
      });
      dialog.addEventListener("click", function (event) {
        if (pressedBackdrop && releasedBackdrop && event.target === dialog) dialog.close();
        pressedBackdrop = false;
        releasedBackdrop = false;
      });

      dialog.addEventListener("close", function () {
        var form = dialog.querySelector("form");
        if (form) form.reset();
        if (dialog.returnFocusTo) dialog.returnFocusTo.focus();
      });
    });
  }

  function fillDialog(dialog, trigger) {
    var heading = trigger.getAttribute("data-modal-heading");
    if (heading) {
      dialog.querySelectorAll("[data-modal-heading-target]").forEach(function (el) {
        el.textContent = heading;
      });
    }

    var context = trigger.getAttribute("data-modal-context");
    if (context) {
      dialog.querySelectorAll("[data-modal-context-target]").forEach(function (el) {
        el.textContent = context;
      });
    }

    var value = trigger.getAttribute("data-modal-value");
    if (value !== null) {
      dialog.querySelectorAll("[data-modal-value-target]").forEach(function (field) {
        setField(field, value);
      });
    }

    Array.from(trigger.attributes).forEach(function (attr) {
      if (attr.name.indexOf("data-modal-field-") !== 0) return;
      var field = document.getElementById(attr.name.slice("data-modal-field-".length));
      if (field && dialog.contains(field)) setField(field, attr.value);
    });
  }

  // Sets a field's value and tells listeners (e.g. a character count) about it.
  function setField(field, value) {
    if (field.type === "checkbox" || field.type === "radio") {
      field.checked = value === "true";
    } else {
      field.value = value;
    }
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* Toasts
     <form data-toast="Facility status updated."> shows that message in the
     page's single <div data-toast-region aria-live="polite"> when submitted.
     A form inside a modal uses method="dialog", so submitting also closes it.
     <button type="button" data-toast="…" hidden> does the same when clicked;
     it ships hidden and is revealed here. Nothing is saved. */
  function initToasts() {
    var region = document.querySelector("[data-toast-region]");
    if (!region) return;

    var toast = region.querySelector(".mw-toast");
    var text = region.querySelector("[data-toast-text]");
    var timer = null;

    function show(message) {
      text.textContent = message;
      toast.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(function () { toast.hidden = true; }, 4000);
    }

    document.querySelectorAll("form[data-toast]").forEach(function (form) {
      form.addEventListener("submit", function (event) {
        if (event.defaultPrevented) return;
        if (form.getAttribute("method") !== "dialog") event.preventDefault();
        show(form.getAttribute("data-toast"));
      });
    });

    document.querySelectorAll("button[data-toast]").forEach(function (button) {
      button.hidden = false;
      button.addEventListener("click", function () {
        show(button.getAttribute("data-toast"));
      });
    });
  }

  /* Tabs
     <div data-tabs> holds a [role="tablist"] of
     <button role="tab" data-tab="panel_id" aria-controls="panel_id" aria-selected="…">
     and the panels they name. Without JavaScript every panel shows, each
     under its own .mw-tabs__panel-title. Here the other panels are hidden,
     the titles become screen-reader-only, and Left/Right/Home/End move
     between tabs. */
  function initTabs() {
    document.querySelectorAll("[data-tabs]").forEach(function (group) {
      var tabs = Array.from(group.querySelectorAll("[data-tab]"));
      if (!tabs.length) return;

      function panelFor(tab) {
        return document.getElementById(tab.getAttribute("data-tab"));
      }

      function select(tab, moveFocus) {
        tabs.forEach(function (other) {
          var selected = other === tab;
          other.setAttribute("aria-selected", String(selected));
          other.tabIndex = selected ? 0 : -1;
          var panel = panelFor(other);
          if (panel) panel.hidden = !selected;
        });
        if (moveFocus) tab.focus();
      }

      group.querySelectorAll(".mw-tabs__panel-title").forEach(function (title) {
        title.classList.add("mw-visually-hidden");
      });

      // The next enabled tab from `index`, stepping by `dir` (1 or -1).
      function step(index, dir) {
        var i = index;
        do {
          i = (i + dir + tabs.length) % tabs.length;
        } while (tabs[i].disabled && i !== index);
        return tabs[i];
      }

      var enabled = tabs.filter(function (tab) { return !tab.disabled; });
      if (!enabled.length) return;

      var current = enabled.filter(function (tab) {
        return tab.getAttribute("aria-selected") === "true";
      })[0] || enabled[0];
      select(current, false);

      tabs.forEach(function (tab, index) {
        tab.addEventListener("click", function () { select(tab, false); });
        tab.addEventListener("keydown", function (event) {
          var next = null;
          if (event.key === "ArrowRight") next = step(index, 1);
          if (event.key === "ArrowLeft") next = step(index, -1);
          if (event.key === "Home") next = enabled[0];
          if (event.key === "End") next = enabled[enabled.length - 1];
          if (next) {
            event.preventDefault();
            select(next, true);
          }
        });
      });
    });
  }

  /* Live text
     <p data-count-for="sms_message"> shows "118 / 160" for that field, using its
     maxlength, and <p data-preview-for="sms_message"> repeats the field's text,
     e.g. an SMS preview. Both follow typing, fields filled in by a modal and
     form resets. Without JavaScript they show the text they were shipped with. */
  function initLiveText() {
    document.querySelectorAll("[data-count-for], [data-preview-for]").forEach(function (output) {
      var id = output.getAttribute("data-count-for") || output.getAttribute("data-preview-for");
      var field = document.getElementById(id);
      if (!field) return;

      function update() {
        if (output.hasAttribute("data-count-for")) {
          var max = field.getAttribute("maxlength");
          output.textContent = field.value.length + (max ? " / " + max : "");
        } else {
          output.textContent = field.value;
        }
      }

      field.addEventListener("input", update);
      if (field.form) {
        // The reset event fires before the fields change back, so wait a tick.
        field.form.addEventListener("reset", function () { setTimeout(update, 0); });
      }
      update();
    });
  }

  /* Section links
     <nav data-subnav> holds links to sections on the same page, styled like
     tabs. The link that was followed gets aria-current="true", so its
     underline moves; the jump itself is plain HTML and works without JavaScript. */
  /* Flash messages
     <div class="mw-alert" data-flash="signed_out" hidden> shows only when the
     address has ?signed_out (Sign out links there), then fades away after
     data-flash-timeout milliseconds, 3000 by default. The parameter is taken
     out of the address, so reloading the page doesn't show it again. */
  function initFlashes() {
    var params = new URLSearchParams(window.location.search);
    document.querySelectorAll("[data-flash]").forEach(function (flash) {
      var key = flash.getAttribute("data-flash");
      if (!params.has(key)) return;
      flash.hidden = false;
      params.delete(key);
      var query = params.toString();
      try {
        history.replaceState(null, "", window.location.pathname + (query ? "?" + query : "") + window.location.hash);
      } catch (error) { /* file:// or a locked history: the message still goes away */ }
      var wait = parseInt(flash.getAttribute("data-flash-timeout"), 10) || 3000;
      window.setTimeout(function () { dismissFlash(flash); }, wait);
    });
  }

  /* Fade the message out, then close up its row so the content below slides up. */
  function dismissFlash(flash) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      flash.hidden = true;
      return;
    }
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      flash.hidden = true;
      flash.classList.remove("is-leaving");
      flash.style.height = "";
    }
    flash.style.height = flash.offsetHeight + "px";
    void flash.offsetHeight; // start the collapse from its current height
    flash.classList.add("is-leaving");
    flash.style.height = "0px";
    flash.addEventListener("transitionend", function (event) {
      if (event.propertyName === "height") finish();
    });
    window.setTimeout(finish, 900);
  }

  function initSubnavs() {
    document.querySelectorAll("[data-subnav]").forEach(function (nav) {
      var links = Array.from(nav.querySelectorAll("a[href^='#']"));
      links.forEach(function (link) {
        link.addEventListener("click", function () {
          links.forEach(function (other) {
            if (other === link) {
              other.setAttribute("aria-current", "true");
            } else {
              other.removeAttribute("aria-current");
            }
          });
        });
      });
    });
  }
})();
