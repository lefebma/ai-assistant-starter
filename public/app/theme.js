// Applies the saved palette before first paint. The Original palette leaves data-palette unset.
(function () {
  try {
    if (localStorage.getItem('havn-palette') === 'havn') document.documentElement.setAttribute('data-palette', 'havn')
  } catch (e) {}
})()
