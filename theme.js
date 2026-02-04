/*
======================================
; Title: theme.js
; Author: Professor Krasso (Bellevue University)
; Date Created: 16 Jan 2023
; Last Updated: 04 Feb 2023
; Modified By: Red
; Description: This code houses JavaScript for the light & dark themes
; Sources Used: Bellevue University Web Dev Web 330 HTML, CSS, and JavaScript Requirements Word Document
;=====================================
*/

// if local storage doesn't have a default, it sets it to light
function setDefaultTheme()
{
    const theme = localStorage.getItem("mode") || "light-theme";
    const iconMode = localStorage.getItem("iconMode") || "fa-toggle-off";
    const iconText = localStorage.getItem("iconText") || "Light Mode";

    document.body.classList.value = theme;
    document.getElementById("icon-mode").classList.add(iconMode);
    document.getElementById("icon-text").innerHTML = iconText;
}

// sets the theme to whatever the user selects; if they haven't selected one, it sets it to light
function setSelectedTheme()
{
    document.body.classList.value = localStorage.getItem("mode") || "light-theme";
}