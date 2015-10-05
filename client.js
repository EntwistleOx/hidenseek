'use strict';

var client = require('ari-client');
var webSocketServer = require('websocket').server;
var http = require('http');
var room = function(ari, id) {
	// Numerical room ID
	this.id = id;
	// Room to the left
	this.left = null;
	// Room to the right
	this.right = null;
	// Room upward
	this.up = null;
	// Room downward
	this.down = null;
	// Room occupants
	this.occupants = [];
	// Underlying conference bridge
	this.bridge = ari.Bridge();
	this.bridge.create({type: 'mixing,dtmf_events'});
}
var participant = function(channel, role, id) {
	// Channel for the participant
	this.channel = channel;
	// Role of the participant
	this.role = role;
	// Numerical identifier of the participant
	this.id = id;
	// Room the participant is currently in
	this.room = null;
	// Playback queue
	this.playbacks = [];
}

function play_sound(ari, participant, sound) {
	participant.playbacks.push(sound);

	function onPlaybackFinished() {
		var played = participant.playbacks.shift();

		console.log('Completed playing %s on channel %s', played, participant.channel.id);

		var prompt = participant.playbacks[0];

		if (prompt == null) {
			console.log('Playback queue on channel %s is now empty', participant.channel.id);
			return;
		}

		console.log('Playing %s on channel %s', prompt, participant.channel.id);
		participant.channel.play({media: prompt})
			.then(function (playback) {
				playback.on('PlaybackFinished', onPlaybackFinished);
			});
	}

	// If this is the first thing in the queue start playing it back
	// Otherwise it'll play in order once the current thing finishes
	if (participant.playbacks.length == 1) {
		console.log('Playing initial sound %s on channel %s', sound, participant.channel.id);
                participant.channel.play({media: sound})
                        .then(function (playback) {
                                playback.on('PlaybackFinished', onPlaybackFinished);
                        });
	} else {
		console.log('Something is already playing on channel %s, adding %s to queue', participant.channel.id, sound);
	}
}

function play_sound_all(rooms, sound) {
	rooms.forEach(function(room) {
		if (room.occupants.length > 0) {
			room.bridge.play({media: sound});
		}
	});
}

function notify_observers(observers, message) {
	observers.forEach(function(connection) {
		connection.sendUTF(message);
	});
}

function horizontal_link(left_room, right_room) {
	left_room.right = right_room;
	right_room.left = left_room;
}

function vertical_link(up_room, down_room) {
	up_room.down = down_room;
	down_room.up = up_room;
}

// Stub for generating the maze
// For the time being, we will generate the following maze:
// 1 - 2 - 3
//     |   |
//     4 - 5 - 6 - 7      14
//     |       |   |       |
// 8 - 9      10 -11 -12 -13
// |           |   |       |
// 15-16 -17 -18 -19  20 -21
//     |       |           |
//    22      23 -24      25
function generate_rooms(ari) {
	var rooms = [];

	var room1 = new room(ari, 1);
	rooms.push(room1);
	var room2 = new room(ari, 2);
	rooms.push(room2);
	var room3 = new room(ari, 3);
	rooms.push(room3);
	horizontal_link(room1, room2);
	horizontal_link(room2, room3);

	var room4 = new room(ari, 4);
	rooms.push(room4);
	var room5 = new room(ari, 5);
	rooms.push(room5);
	var room6 = new room(ari, 6);
	rooms.push(room6);
	var room7 = new room(ari, 7);
	rooms.push(room7);
	var room14 = new room(ari, 14);
	rooms.push(room14);
	horizontal_link(room4, room5);
	horizontal_link(room5, room6);
	horizontal_link(room6, room7);
	vertical_link(room2, room4);
	vertical_link(room3, room5);

	var room8 = new room(ari, 8);
	rooms.push(room8);
	var room9 = new room(ari, 9);
	rooms.push(room9);
	var room10 = new room(ari, 10);
	rooms.push(room10);
	var room11 = new room(ari, 11);
	rooms.push(room11);
	var room12 = new room(ari, 12);
	rooms.push(room12);
	var room13 = new room(ari, 13);
	rooms.push(room13);
	horizontal_link(room8, room9);
	horizontal_link(room10, room11);
	horizontal_link(room11, room12);
	horizontal_link(room12, room13);
	vertical_link(room4, room9);
	vertical_link(room6, room10);
	vertical_link(room7, room11);
	vertical_link(room14, room13);

	var room15 = new room(ari, 15);
	rooms.push(room15);
	var room16 = new room(ari, 16);
	rooms.push(room16);
	var room17 = new room(ari, 17);
	rooms.push(room17);
	var room18 = new room(ari, 18);
	rooms.push(room18);
	var room19 = new room(ari, 19);
	rooms.push(room19);
	var room20 = new room(ari, 20);
	rooms.push(room20);
	var room21 = new room(ari, 21);
	rooms.push(room21);
	horizontal_link(room15, room16);
	horizontal_link(room16, room17);
	horizontal_link(room17, room18);
	horizontal_link(room18, room19);
	horizontal_link(room20, room21);
	vertical_link(room8, room15);
	vertical_link(room10, room18);
	vertical_link(room11, room19);
	vertical_link(room13, room21);

	var room22 = new room(ari, 22);
	rooms.push(room22);
	var room23 = new room(ari, 23);
	rooms.push(room23);
	var room24 = new room(ari, 24);
	rooms.push(room24);
	var room25 = new room(ari, 25);
	rooms.push(room25);
	horizontal_link(room23, room24);
	vertical_link(room16, room22);
	vertical_link(room18, room23);
	vertical_link(room21, room25);

	return rooms;
}

function get_random_room(rooms) {
	var room_number = Math.floor(Math.random() * (rooms.length));
	return rooms[room_number];
}

client.connect('http://127.0.0.1:8088', 'asterisk', 'asterisk', function(err, ari) {
	var rooms;
	var participants = [];
	var observers = [];
	var hiders = 0;
	var seekers = 0;
	var participant_id = 1;

	function joinRoom(room, participant) {
		if (participant.room) {
			console.log('Channel %s leaving room %d(bridge %s)', participant.channel.id, participant.room.id, participant.room.bridge.id);
			var i = participant.room.occupants.indexOf(participant);
			participant.room.occupants.splice(i, 1);
			if (participant.role == 'seeker') {
				participant.room.bridge.play({media: 'sound:confbridge-leave'});
			}
			notify_observers(observers, JSON.stringify({ type: 'leave_room', room: participant.room.id, channel: participant.channel.id, id: participant.id, role: participant.role }));
		}
		participant.room = room;
		if (room) {
			console.log('Channel %s entering room %d(bridge %s) as %s', participant.channel.id, room.id, room.bridge.id, participant.role);
			room.occupants.push(participant);
			// addChannel will move the channel as appropriate, we don't need to explicitly remove
			if (participant.role == 'seeker') {
				room.bridge.play({media: 'sound:confbridge-join'});
			}
			room.bridge.addChannel({channel: participant.channel.id});
			play_sound(ari, participant, 'number:' + room.id);
			notify_observers(observers, JSON.stringify({ type: 'join_room', room: participant.room.id, channel: participant.channel.id, id: participant.id, role: participant.role }));
		}
	}

	function onDtmfReceived(event, channel) {
		var participant = participants.filter(function(item) {
			return item.channel.id === channel.id;
		})[0];
		var nextRoom = null;

		if (event.digit == '*') {
			if (participant.role != 'seeker') {
				console.log('Channel %s wants to start the game but they are not a seeker', channel.id);
				play_sound(ari, participant, 'sound:beeperr');
				return;
			} else if (hiders == 0) {
				console.log('Channel %s wants to start the game but there are no hiders', channel.id);
				play_sound(ari, participant, 'sound:beeperr');
				return;
			}
			notify_observers(observers, JSON.stringify({ type: 'game_started' }));
			play_sound_all(rooms, 'sound:beep');
		} else if (event.digit == '2') {
			// They want to go up
			console.log('Channel %s wants to move to the room above them', channel.id);
			nextRoom = participant.room.up;
		} else if (event.digit == '8') {
			// They want to go down
			console.log('Channel %s wants to move to the room below them', channel.id);
			nextRoom = participant.room.down;
		} else if (event.digit == '4') {
			// They want to go left
			console.log('Channel %s wants to move to the room to the left of them', channel.id);
			nextRoom = participant.room.left;
		} else if (event.digit == '6') {
			// They want to go right
			console.log('Channel %s wants to move to the room to the right of them', channel.id);
			nextRoom = participant.room.right;
		} else if (event.digit == '0') {
			// They want to grab any hiding participant
			if (participant.role != 'seeker') {
				console.log('Channel %s wants to grab hiders but they are not a seeker', channel.id);
				return;
			}

			console.log('Channel %s is grabbing all hiders in room %d(bridge %s)', channel.id, participant.room.id, participant.room.bridge.id);

			notify_observers(observers, JSON.stringify({ type: 'catch_attempt', room: participant.room.id, channel: participant.channel.id, id: participant.id }));

			participant.room.occupants.forEach(function(item) {
				if (item.role != 'hider') {
					return;
				}
				console.log('Channel %s was caught by %s, they are now a seeker', item.id, channel.id);
				hiders--;
				seekers++;
				item.role = 'seeker';
				notify_observers(observers, JSON.stringify({ type: 'hider_caught', room: participant.room.id, channel: item.channel.id, id: item.id }));
			});

			console.log('Seeker count is now %d and hider count is now %d', seekers, hiders);

			if (hiders == 0) {
				// All the hiders are gone, the game can end
				console.log('The game has no hiders left in it, considering it ended');
				notify_observers(observers, JSON.stringify({ type: 'game_ended' }));
				play_sound_all(rooms, 'sound:beeperr');
			} else {
				participant.room.bridge.play({media: 'sound:beep'});
			}

			return;
		} else {
			console.log('Channel %s tried to use invalid DTMF digit %s', channel.id, event.digit);
			return;
		}

		if (nextRoom == null) {
			console.log('Channel %s tried to move in a direction where no room exists', channel.id);
			play_sound(ari, participant, 'sound:oops1');
			notify_observers(observers, JSON.stringify({ type: 'invalid_room_move', room: participant.room.id, channel: participant.channel.id, id: participant.id, direction: event.digit }));
			return;
		}

		joinRoom(nextRoom, participant);
	}

	function onStasisStart(event, channel) {
		channel.answer(function(err) {
			var room = get_random_room(rooms);
			var joiner = new participant(channel, event.args[0], participant_id++);
			console.log('Channel %s entered app', channel.id);
			channel.on('ChannelDtmfReceived', onDtmfReceived);
			if (joiner.role == 'seeker') {
				seekers++;
			} else if (joiner.role == 'hider') {
				hiders++;
			}
			console.log('Seeker count is now %d and hider count is now %d', seekers, hiders);
			play_sound(ari, joiner, 'sound:queue-thereare');
			play_sound(ari, joiner, 'number:' + joiner.id);
			participants.push(joiner);
			notify_observers(observers, JSON.stringify({ type: 'join_game', channel: channel.id, id: joiner.role, role: joiner.role }));
			play_sound(ari, joiner, 'sound:conf-enteringno');
			joinRoom(room, joiner);
		});
	}

	function onStasisEnd(event, channel) {
		console.log('Channel %s leaving hide and seek', channel.id);
                var participant = participants.filter(function(item) {
                        return item.channel.id === channel.id;
                })[0];
		// Drop the respective count
		if (participant.role == 'seeker') {
			seekers--;
		} else if (participant.role == 'hider') {
			hiders--;
		}
		console.log('Seeker count is now %d and hider count is now %d', seekers, hiders);
		// It's safe to call joinRoom with a null room, it'll just end up removing it from the one it is in
		joinRoom(null, participant);
		notify_observers(observers, JSON.stringify({ type: 'leave_game', channel: channel.id, id: participant.id, role: participant.role }));
		// Since the channel is going away remove it as a valid participant
		var i = participants.indexOf(participant);
		participants.splice(i, 1);

		if (hiders == 0 || seekers == 0) {
			console.log('The game has no hiders or seekers left in it, considering it ended');
			notify_observers(observers, JSON.stringify({ type: 'game_ended' }));
			play_sound_all(rooms, 'sound:beep');
		}
	}

	function onObserverConnect(request) {
		console.log('New observer connection from ' + request.origin);

		var connection = request.accept(null, request.origin);
		connection.on('close', onObserverDisconnect);

		observers.push(connection);

		participants.forEach(function(participant) {
			connection.sendUTF(JSON.stringify({ type: 'join_game', channel: participant.channel.id, role: participant.role }));
			connection.sendUTF(JSON.stringify({ type: 'join_room', room: participant.room.id, channel: participant.channel.id, role: participant.role }));
		});
	}

	function onObserverDisconnect(connection) {
		console.log('Observer disconnected');

		var i = observers.indexOf(connection);
		observers.splice(i, 1);
	}

	var server = http.createServer(function(request, response) {
	});
	server.listen(6066, function() {
		console.log('WebSocket server listening on port 6066');
	});

	var wsServer = new webSocketServer({
		httpServer: server
	});
	wsServer.on('request', onObserverConnect);

	rooms = generate_rooms(ari);
	ari.on('StasisStart', onStasisStart);
	ari.on('StasisEnd', onStasisEnd);
	ari.start('hide-n-seek');
})
.catch(function (err) {
	console.log(err);
});
