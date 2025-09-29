#include <iostream>
#include <vector>
using namespace std;

int josephus(int n, int k) {
    vector<int> players;
    for (int i = 1; i <= n; i++) {
        players.push_back(i);
    }

    int index = 0; // start from first player
    while (players.size() > 1) {
        index = (index + k - 1) % players.size(); // move k-1 steps
        players.erase(players.begin() + index);   // eliminate player
    }

    return players[0]; // last remaining player
}

int main() {
    int n, k;
    cout << "Enter number of players (n): ";
    cin >> n;
    cout << "Enter step count (k): ";
    cin >> k;

    int winner = josephus(n, k);
    cout << "The winner is player " << winner << endl;

    return 0;
}
