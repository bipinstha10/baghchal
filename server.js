const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve the main game file
app.use(express.static('public'));

let waitingPlayer = null;
const gameRooms = {}; // Stores game state for each room

// This is the same game logic class from your original file.
// Running it on the server ensures a single source of truth for the game state.
class BaghchalBoard {
    constructor() {
        this.board = Array(5).fill(0).map(() => Array(5).fill('.'));
        this.board[0][0] = 'T';
        this.board[0][4] = 'T';
        this.board[4][0] = 'T';
        this.board[4][4] = 'T';
        this.goats_placed = 0;
        this.goats_killed = 0;
        this.turn = 'G'; // 'T' for Tiger, 'G' for Goat
        this.state_history = [];
        this.selected_goat = null;
        this.selected_tiger = null;
    }

    saveState() {
        this.state_history.push({
            board: JSON.parse(JSON.stringify(this.board)),
            goats_placed: this.goats_placed,
            goats_killed: this.goats_killed,
            turn: this.turn
        });
    }

    undoMove() {
        if (this.state_history.length > 0) {
            const prevState = this.state_history.pop();
            this.board = prevState.board;
            this.goats_placed = prevState.goats_placed;
            this.goats_killed = prevState.goats_killed;
            this.turn = prevState.turn;
            this.selected_goat = null; // Selections are client-side, but reset them
            this.selected_tiger = null;
            return true;
        }
        return false;
    }

    is_even(number) { return number % 2 === 0; }

    is_valid_move(start_row, start_col, end_row, end_col) {
        if (end_row < 0 || end_row >= 5 || end_col < 0 || end_col >= 5) return false;
        if (this.board[end_row][end_col] !== '.') return false;

        if (this.turn === 'T') return this.validate_tiger_move(start_row, start_col, end_row, end_col);
        if (this.turn === 'G') return this.validate_goat_move(start_row, start_col, end_row, end_col);
        return false;
    }

    validate_tiger_move(start_row, start_col, end_row, end_col) {
        if (this.board[start_row][start_col] !== 'T') return false;
        const row_diff = Math.abs(start_row - end_row);
        const col_diff = Math.abs(start_col - end_col);

        if ((row_diff === 1 && col_diff === 0) || (col_diff === 1 && row_diff === 0)) return true;
        if (this.is_even(start_row + start_col) && row_diff === 1 && col_diff === 1) return true;

        if (row_diff === 2 && col_diff === 0) {
            return this.board[(start_row + end_row) / 2][start_col] === 'G';
        } else if (col_diff === 2 && row_diff === 0) {
            return this.board[start_row][(start_col + end_col) / 2] === 'G';
        } else if (this.is_even(start_row + start_col) && row_diff === 2 && col_diff === 2) {
            return this.board[(start_row + end_row) / 2][(start_col + end_col) / 2] === 'G';
        }
        return false;
    }

    validate_goat_move(start_row, start_col, end_row, end_col) {
        if (this.goats_placed < 20) {
            return this.board[end_row][end_col] === '.';
        } else {
            if (this.board[start_row][start_col] !== 'G') return false;
            const row_diff = Math.abs(start_row - end_row);
            const col_diff = Math.abs(start_col - end_col);
            if ((row_diff === 1 && col_diff === 0) || (col_diff === 1 && row_diff === 0)) return true;
            if (this.is_even(start_row + start_col) && row_diff === 1 && col_diff === 1) return true;
        }
        return false;
    }

    make_move(start_row, start_col, end_row, end_col) {
        this.saveState();
        if (this.turn === 'G' && this.goats_placed < 20) {
            this.board[end_row][end_col] = 'G';
            this.goats_placed++;
            this.turn = 'T';
        } else if (this.board[start_row][start_col] === 'T') {
            const row_diff = Math.abs(start_row - end_row);
            const col_diff = Math.abs(start_col - end_col);
            if (row_diff === 2 || col_diff === 2) {
                const jump_row = (start_row + end_row) / 2;
                const jump_col = (start_col + end_col) / 2;
                if (this.board[jump_row][jump_col] === 'G') {
                    this.board[jump_row][jump_col] = '.';
                    this.goats_killed++;
                }
            }
            this.board[end_row][end_col] = 'T';
            this.board[start_row][start_col] = '.';
            this.turn = 'G';
        } else if (this.board[start_row][start_col] === 'G') {
            this.board[end_row][end_col] = 'G';
            this.board[start_row][start_col] = '.';
            this.turn = 'T';
        }
    }

    can_any_piece_move(piece_type) {
        for (let r = 0; r < 5; r++) {
            for (let c = 0; c < 5; c++) {
                if (this.board[r][c] === piece_type) {
                    for (let dr = -2; dr <= 2; dr++) {
                        for (let dc = -2; dc <= 2; dc++) {
                            const nr = r + dr;
                            const nc = c + dc;
                            const originalTurn = this.turn;
                            this.turn = piece_type;
                            const isValid = this.is_valid_move(r, c, nr, nc);
                            this.turn = originalTurn;
                            if (isValid) return true;
                        }
                    }
                }
            }
        }
        return false;
    }
    
    check_win_conditions() {
        if (this.goats_killed >= 5) return 'Tiger';
        if (this.turn === 'T' && !this.can_any_piece_move('T')) return 'Goat';
        if (this.turn === 'G' && this.goats_placed === 20 && !this.can_any_piece_move('G')) return 'Tiger';
        return null;
    }
}


io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    if (waitingPlayer) {
        // Start a game
        const room = `room_${socket.id}_${waitingPlayer.id}`;
        gameRooms[room] = {
            game: new BaghchalBoard(),
            players: { [waitingPlayer.id]: 'G', [socket.id]: 'T' } // Goat (G) starts
        };

        waitingPlayer.join(room);
        socket.join(room);

        io.to(waitingPlayer.id).emit('gameStart', { role: 'G', room: room, state: gameRooms[room].game });
        io.to(socket.id).emit('gameStart', { role: 'T', room: room, state: gameRooms[room].game });
        
        waitingPlayer = null;
    } else {
        waitingPlayer = socket;
        socket.emit('waiting', 'Waiting for another player to join...');
    }
    
    socket.on('makeMove', (data) => {
        const { room, move } = data;
        const gameRoom = gameRooms[room];
        if (!gameRoom) return;

        const playerRole = gameRoom.players[socket.id];
        const game = gameRoom.game;
        
        // Validate if it's the correct player's turn
        if (playerRole === game.turn) {
            const { start_row, start_col, end_row, end_col } = move;
            // Validate move on the server
            if (game.is_valid_move(start_row, start_col, end_row, end_col)) {
                game.make_move(start_row, start_col, end_row, end_col);
                const winner = game.check_win_conditions();

                // Broadcast the updated state to everyone in the room
                io.to(room).emit('gameStateUpdate', { state: game, winner: winner });
            } else {
                // Inform the player of an invalid move
                socket.emit('invalidMove', { message: 'Invalid move. Please try again.' });
            }
        }
    });

    socket.on('resetGame', (data) => {
        const { room } = data;
        if (gameRooms[room]) {
            gameRooms[room].game = new BaghchalBoard();
            io.to(room).emit('gameStateUpdate', { state: gameRooms[room].game, winner: null });
        }
    });

    socket.on('undoMove', (data) => {
        const { room } = data;
        if (gameRooms[room] && gameRooms[room].game.undoMove()) {
             io.to(room).emit('gameStateUpdate', { state: gameRooms[room].game, winner: null });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
        }
        // Also handle disconnection from a room
        for (const room in gameRooms) {
            if (gameRooms[room].players[socket.id]) {
                io.to(room).emit('opponentDisconnected', 'Your opponent has disconnected.');
                delete gameRooms[room]; // Clean up the room
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));