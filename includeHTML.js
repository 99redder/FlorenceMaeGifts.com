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


function runIncludedScripts(container) {
  var scripts = container.getElementsByTagName("script");
  var i;
  for (i = 0; i < scripts.length; i++) {
    var oldScript = scripts[i];
    var newScript = document.createElement("script");
    var j;

    for (j = 0; j < oldScript.attributes.length; j++) {
      var attr = oldScript.attributes[j];
      newScript.setAttribute(attr.name, attr.value);
    }

    newScript.text = oldScript.text || oldScript.textContent || "";
    oldScript.parentNode.replaceChild(newScript, oldScript);
  }
}

function includeHTML() {
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
            elmnt.innerHTML = this.responseText;
            runIncludedScripts(elmnt);
          }
          if (this.status == 404) {elmnt.innerHTML = "Page not found.";}
          /*remove the attribute, and call this function once more:*/
          elmnt.removeAttribute("w3-include-html");
          includeHTML();
        }
      }
      xhttp.open("GET", file, true);
      xhttp.send();
      /*exit the function:*/
      return;
    }
  }
};
