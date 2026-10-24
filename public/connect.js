/* The connect page: one copy button for the connector URL, wired by the
   shared copy helper in start-room.js, which this page loads first. */
(function () {
  "use strict";
  var startRoom = window.orskoStartRoom;
  if (!startRoom) throw new Error("start-room.js must load before connect.js");
  startRoom.wireCopy("copy-connector", "connector-url");
})();
