(function loadPdfFallback() {
      if (window.jspdf) return;
      var a = document.createElement('script');
      a.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      a.onload = function () {
        var b = document.createElement('script');
        b.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js';
        document.head.appendChild(b);
      };
      document.head.appendChild(a);
    })();
