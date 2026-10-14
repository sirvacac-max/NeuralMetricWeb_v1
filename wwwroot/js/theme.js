(function () {
    var KEY = "nmw-theme";
    /** @param {string} t */
    function apply(t) {
        var r = document.documentElement;
        if (t && t !== "auto") { r.setAttribute("data-theme", t); }
        else { r.removeAttribute("data-theme"); }
    }
    function read() { try { return localStorage.getItem(KEY) || "auto"; } catch (e) { return "auto"; } }
    try { apply(read()); } catch (e) { }
    window["themeInit"] = function () { return read(); };
    window["themeCycle"] = function () {
        var order = ["auto", "light", "dark"];
        var t = order[(order.indexOf(read()) + 1) % 3];
        try { localStorage.setItem(KEY, t); } catch (e) { }
        apply(t);
        return t;
    };
})();

(function () {
    var KEY = "nmw-lang";
    window["langInit"] = function () {
        try {
            var l = localStorage.getItem(KEY);
            if (l) return l;
            return (navigator.language || "en").toLowerCase().indexOf("es") === 0 ? "es" : "en";
        } catch (e) { return "en"; }
    };
    window["langSet"] = function (l) { try { localStorage.setItem(KEY, l); } catch (e) { } return l; };
})();

(function () {
    window["nmwPrint"] = function () { try { window.print(); } catch (e) { } };
})();

(function () {
    window["nmwDownload"] = function (name, text, mime) {
        try {
            var blob = new Blob(["\ufeff" + text], { type: (mime || "text/csv") + ";charset=utf-8;" });
            var url = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = url; a.download = name; document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        } catch (e) { }
    };
})();
