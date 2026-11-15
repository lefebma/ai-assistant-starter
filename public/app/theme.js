// Applies the saved palette before first paint. The Original palette leaves data-palette unset.
(function () {
  try {
    var p = localStorage.getItem('havn-palette')
    if (p === 'havn' || p === 'havn2') document.documentElement.setAttribute('data-palette', p)
  } catch (e) {}
})()
