/*
======================================
; Title: includeHTML.js
; Author: W3 Schools
; Date Created: 28 January 2023
; Last Updated: 23 February 2026
; Modified By: Red
; Description: This code houses JavaScript for the light & dark themes
; Sources Used: W3 Schools How TO - Include HTML, URL: https://www.w3schools.com/howto/howto_html_include.asp
;=====================================
*/


function includeHTML(callback) {
  var z, i, elmnt, file, xhttp;
  /*loop through a collection of all HTML elements:*/
  z = document.getElementsByTagName("*");
  for (i = 0; i < z.length; i++) {
    elmnt = z[i];
    /*search for elements with a certain attribute:*/
    file = elmnt.getAttribute("w3-include-html");
    if (file) {
      /*make an HTTP request using the attribute value as the file name:*/
      xhttp = new XMLHttpRequest();
      xhttp.onreadystatechange = function() {
        if (this.readyState == 4) {
          if (this.status == 200) {
            var parser = new DOMParser();
            var doc = parser.parseFromString(this.responseText, "text/html");
            doc.querySelectorAll("script").forEach(function(script) {
              script.remove();
            });
            elmnt.replaceChildren.apply(elmnt, Array.prototype.slice.call(doc.body.childNodes));
          }
          if (this.status == 404) {elmnt.textContent = "Page not found.";}
          /*remove the attribute, and call this function once more:*/
          elmnt.removeAttribute("w3-include-html");
          includeHTML(callback);
        }
      }
      xhttp.open("GET", file, true);
      xhttp.send();
      /*exit the function:*/
      return;
    }
  }
  if (typeof callback === "function") {
    callback();
  }
};
